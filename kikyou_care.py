"""Chat-priority maintenance and explicit, reviewable long-term memory controls."""
import copy
import hashlib
import json
import threading
import time

from flask import jsonify, request
from kikyou_stream import Control, stream_backend


def initialize_care(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS web_maintenance (
      session_id INTEGER PRIMARY KEY, due REAL NOT NULL, extract INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS web_memory_excluded (message_id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS web_memory_suppressed (fingerprint TEXT PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_memory_candidates (
      id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, payload TEXT NOT NULL,
      sources TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending');
    ''')
    db.execute("UPDATE web_maintenance SET status='queued',due=? WHERE status='running'", (time.time()+8,))
    db.commit()


class Interrupted(Exception):
    pass


class BackgroundBackend:
    def __init__(self, backend, engine, control):
        self.backend = copy.copy(backend)
        self.backend.thinking_enabled = False
        self.backend.web_search_enabled = False
        self.engine, self.control = engine, control

    def complete(self, messages, max_tokens, temperature=.2, top_p=.8):
        if self.control.stop.is_set():
            raise Interrupted()
        parts = stream_backend(self.backend, messages, dict(max_tokens=max_tokens, temperature=temperature, top_p=top_p), self.engine, self.control)
        result = ''.join(text for text, _thought in parts)
        if self.control.stop.is_set():
            raise Interrupted()
        return result


class Care:
    def __init__(self, web):
        self.web, self.guard = web, threading.RLock()
        self.control = None
        self.revision = 0
        self.backends = {}
        self.last_backend = None

    @property
    def db(self):
        return self.web['conn']

    @property
    def engine(self):
        return self.web['engine']

    def interrupt(self):
        with self.guard:
            if self.control:
                self.control.cancel()

    def changed(self):
        self.revision += 1
        self.interrupt()

    def enqueue(self, sid, backend):
        extract = self.engine['user_message_count'](self.db, sid) % self.engine['MEMORY_EXTRACT_EVERY'] == 0
        with self.guard:
            self.backends[sid] = backend
            self.last_backend = backend
            self.db.execute("UPDATE web_maintenance SET status='queued',due=?,error='' WHERE status='waiting'",(time.time()+8,))
            self.db.execute('''INSERT INTO web_maintenance(session_id,due,extract) VALUES (?,?,?)
              ON CONFLICT(session_id) DO UPDATE SET due=excluded.due, extract=MAX(web_maintenance.extract,excluded.extract),status='queued',error='' ''', (sid,time.time()+8,int(extract)))
            self.db.commit()

    def tick(self):
        # Never wait for the foreground lock: maintenance yields whenever chat is active.
        if self.web['generations'].controls or not self.web['generation_lock'].acquire(blocking=False):
            return
        try:
            row = self.db.execute("SELECT * FROM web_maintenance WHERE status='queued' AND due<=? ORDER BY due LIMIT 1", (time.time(),)).fetchone()
            if not row:
                return
            sid = row['session_id']
            if not self.web['session_row'](sid):
                self.db.execute('DELETE FROM web_maintenance WHERE session_id=?', (sid,)); self.db.commit()
                return
            with self.guard:
                if self.web['generations'].controls:
                    return
                control = self.control = Control()
                control.session_id = sid
                revision = self.revision
            self.db.execute("UPDATE web_maintenance SET status='running' WHERE session_id=?", (sid,)); self.db.commit()
            try:
                backend = self.backends.get(sid)
                # Do not load a local model just to recover deferred work on app startup.
                if backend is None:
                    backend = self.last_backend
                    if backend is None:
                        self.db.execute("UPDATE web_maintenance SET status='waiting',error='等待下一次聊天后继续整理。' WHERE session_id=?",(sid,));self.db.commit()
                        return
                wrapped = BackgroundBackend(backend,self.engine,control)
                control.purpose = 'title'
                self.engine['generate_session_title'](self.db,sid,wrapped)
                control.purpose = 'summary'
                self.engine['update_session_summary'](self.db,sid,wrapped)
                if row['extract']:
                    control.purpose = 'memory'
                    self.propose(sid,wrapped,revision)
                if control.stop.is_set():
                    raise Interrupted()
                self.db.execute('DELETE FROM web_maintenance WHERE session_id=?',(sid,)); self.db.commit()
                self.backends.pop(sid,None)
            except Interrupted:
                self.db.rollback()
                self.db.execute("UPDATE web_maintenance SET status='queued',due=? WHERE session_id=?",(time.time()+8,sid));self.db.commit()
            except Exception:
                self.db.rollback()
                self.db.execute("UPDATE web_maintenance SET status='failed',error='后台整理暂未完成；下次聊天后会再尝试。' WHERE session_id=?",(sid,));self.db.commit()
            finally:
                with self.guard:
                    self.control = None
        finally:
            self.web['generation_lock'].release()

    def loop(self):
        while True:
            try:
                with self.web['app'].app_context():
                    self.tick()
            except Exception:
                pass
            time.sleep(.25)

    @staticmethod
    def fingerprint(content):
        return hashlib.sha256(''.join(content.lower().split()).encode()).hexdigest()

    def excluded(self, ids):
        return any(self.db.execute('SELECT 1 FROM web_memory_excluded WHERE message_id=?',(ident,)).fetchone() for ident in ids)

    def suppressed(self, content):
        return any(row['content']==content or self.engine['is_near_duplicate'](row['content'],content)
                   for row in self.db.execute('SELECT content FROM web_memory_suppressed'))

    def matches(self, memory):
        rows = self.db.execute('SELECT * FROM memories').fetchall()
        exact = next((r for r in rows if self.fingerprint(r['content'])==self.fingerprint(memory['content'])),None)
        conflict = next((r for r in rows if (r['category']==memory['category'] and r['memory_key']==memory['key']) or self.engine['is_near_duplicate'](r['content'],memory['content'])),None)
        return exact,conflict

    def propose(self, sid, backend, revision):
        rows = self.db.execute('''SELECT id,content FROM messages WHERE session_id=? AND role='user'
          AND id NOT IN (SELECT message_id FROM web_memory_excluded) ORDER BY id DESC LIMIT 16''',(sid,)).fetchall()
        if not rows:
            return
        source = {r['id']:r['content'] for r in rows}
        prompt = '''仅从下面用户亲口确认的话中提取稳定且未来有用的事实。不要推测，不要把玩笑、假设、角色扮演、一次性情绪或问题记成偏好。没有合适事实就返回空列表。
输出严格 JSON：{"memories":[{"category":"profile|preference|habit|relationship|event|promise|inside_joke","key":"简短主题","content":"中性中文事实，最多280字","importance":5,"tags":[],"source_id":用户消息编号,"quote":"从该消息逐字摘录的事实依据"}]}。
用户消息：\n''' + json.dumps(list(reversed([dict(r) for r in rows])),ensure_ascii=False)
        raw = backend.complete([dict(role='user',content=prompt)],max_tokens=600,temperature=.15,top_p=.8)
        with self.guard:
            if self.revision != revision:
                raise Interrupted()
            for item in self.engine['parse_memory_json'](raw)[:8]:
                if not isinstance(item,dict):
                    continue
                memory = self.engine['validate_memory'](item)
                source_id, quote = item.get('source_id'), item.get('quote')
                if not memory or not isinstance(source_id,int) or source_id not in source or not isinstance(quote,str) or not quote.strip() or quote not in source[source_id]:
                    continue
                if self.excluded([source_id]) or self.suppressed(memory['content']) or self.matches(memory)[0]:
                    continue
                pending = self.db.execute("SELECT payload FROM web_memory_candidates WHERE status='pending'").fetchall()
                if any(self.engine['is_near_duplicate'](json.loads(r['payload'])['content'],memory['content']) for r in pending):
                    continue
                self.db.execute('INSERT OR IGNORE INTO web_memory_candidates(session_id,payload,sources,fingerprint) VALUES (?,?,?,?)',
                    (sid,json.dumps(memory,ensure_ascii=False),json.dumps([source_id]),self.fingerprint(memory['content'])))
            self.db.commit()

    def store(self, memory, replace_id=None):
        exact, conflict = self.matches(memory)
        if exact:
            return dict(exact)
        if conflict and replace_id != conflict['id']:
            raise ValueError('与已有记忆冲突，请明确选择更新原记忆。')
        if conflict:
            self.engine['archive_memory_revision'](self.db,conflict,'用户确认更新')
            self.db.execute('UPDATE memories SET content=?,updated_at=? WHERE id=?',(memory['content'],self.engine['now'](),conflict['id']))
            ident = conflict['id']
        else:
            stamp = self.engine['now']()
            cursor = self.db.execute('INSERT INTO memories(category,memory_key,content,importance,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
                (memory['category'],memory['key'],memory['content'],memory['importance'],memory['tags'],stamp,stamp))
            ident = cursor.lastrowid
        # Let normal recall refresh embeddings later; saving a fact needs no model call.
        self.db.commit()
        return dict(self.engine['get_memory'](self.db,ident))

    def register(self):
        app = self.web['app']

        @app.get('/api/care')
        def status():
            candidates=[]
            for row in self.db.execute("SELECT * FROM web_memory_candidates WHERE status='pending' ORDER BY id DESC LIMIT 50"):
                item=dict(row); memory=json.loads(item.pop('payload')); sources=json.loads(item['sources'])
                if self.excluded(sources) or self.suppressed(memory['content']):
                    continue
                evidence=[self.db.execute('SELECT content FROM messages WHERE id=?',(mid,)).fetchone() for mid in sources]
                if not all(evidence):
                    continue
                exact,conflict=self.matches(memory)
                if exact:
                    continue
                item.update(memory=memory,conflict=dict(conflict) if conflict else None,evidence=[r['content'][:300] for r in evidence])
                candidates.append(item)
            return jsonify(candidates=candidates, jobs=[dict(r) for r in self.db.execute('SELECT * FROM web_maintenance')])

        @app.post('/api/messages/<int:ident>/memory')
        def message_memory(ident):
            payload=request.get_json(silent=True) or {}
            row=self.db.execute("SELECT * FROM messages WHERE id=? AND role='user'",(ident,)).fetchone()
            if not row:
                return jsonify(error='只能从已保存的用户消息操作记忆'),404
            with self.guard:
                self.changed()
                action=payload.get('action')
                if action=='exclude':
                    self.db.execute('INSERT OR IGNORE INTO web_memory_excluded VALUES (?)',(ident,))
                elif action=='allow':
                    self.db.execute('DELETE FROM web_memory_excluded WHERE message_id=?',(ident,))
                elif action=='remember':
                    memory=self.engine['validate_memory'](dict(category='event',key=payload.get('content','')[:48],content=payload.get('content',''),importance=7,tags=[]))
                    if not memory:
                        return jsonify(error='请填写 1–280 字的记忆内容'),400
                    exact,conflict=self.matches(memory)
                    if conflict and not exact and payload.get('replace_id')!=conflict['id']:
                        return jsonify(error='发现相近记忆，请确认是否更新。',conflict=dict(conflict)),409
                    result=self.store(memory,payload.get('replace_id'))
                    self.db.execute('DELETE FROM web_memory_excluded WHERE message_id=?',(ident,))
                    self.db.commit()
                    return jsonify(result)
                else:
                    return jsonify(error='无效操作'),400
                self.db.commit()
                return jsonify(ok=True)

        @app.post('/api/memory-candidates/<int:ident>')
        def review(ident):
            payload=request.get_json(silent=True) or {}
            with self.guard:
                row=self.db.execute("SELECT * FROM web_memory_candidates WHERE id=? AND status='pending'",(ident,)).fetchone()
                if not row:
                    return jsonify(error='这条建议已处理或不存在'),404
                memory=json.loads(row['payload'])
                self.changed()
                if payload.get('action')=='reject':
                    self.db.execute('INSERT OR IGNORE INTO web_memory_suppressed VALUES (?,?)',(row['fingerprint'],memory['content']))
                    state='rejected'
                elif payload.get('action')=='accept':
                    sources=json.loads(row['sources'])
                    if self.excluded(sources) or any(not self.db.execute('SELECT 1 FROM messages WHERE id=?',(mid,)).fetchone() for mid in sources):
                        return jsonify(error='来源消息已删除或设为不要记'),409
                    if self.suppressed(memory['content']):
                        return jsonify(error='这条内容已被你纠正或设为不要记，请重新加载。'),409
                    try:
                        self.store(memory,payload.get('replace_id'))
                    except ValueError as error:
                        return jsonify(error=str(error)),409
                    state='accepted'
                else:
                    return jsonify(error='无效操作'),400
                self.db.execute('UPDATE web_memory_candidates SET status=? WHERE id=?',(state,ident));self.db.commit()
                return jsonify(ok=True)

        threading.Thread(target=self.loop,daemon=True).start()
