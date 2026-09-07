"""Persistent, cancellable generation jobs shared by the web UI and its event stream."""
import http.client
import json
import re
import socket
import threading
import time
import uuid
from urllib.parse import urlsplit

from flask import Response, jsonify, request

TERMINAL = {'complete', 'stopped', 'failed'}


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS web_generations (
        id TEXT PRIMARY KEY, session_id INTEGER NOT NULL, user_id INTEGER,
        assistant_id INTEGER, status TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        reasoning TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute("UPDATE web_generations SET status='failed', error='程序已重启，本次回复未完成。' WHERE status IN ('running','stopping')")
    db.commit()


def visible_text(raw, engine, final=False):
    # Hold incomplete markup so thinking and action fragments never flash on screen.
    text = engine['remove_thinking_process'](raw)
    text = re.sub(r'<[^>]*$', '', text)
    if not final:
        text = re.sub(r'[（(\[*][^）)\]*\n]*$', '', text)
        lines = text.split('\n')
        if re.match(r'^\s*(你刚才|说完|这时|此时|随后|接着)', lines[-1]):
            text = '\n'.join(lines[:-1])
    return engine['remove_action_descriptions'](text)


class Control:
    def __init__(self):
        self.stop = threading.Event()
        self.connection = None
        self.socket = None

    def cancel(self):
        self.stop.set()
        connection = self.connection
        sock = self.socket or (connection.sock if connection else None)
        if sock:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def stream_backend(backend, messages, generation, engine, control):
    ledger = engine.get('usage_ledger') if backend.mode == 'api' else None
    ident = ledger.begin(backend,control) if ledger else None
    control.usage = None
    status = 'failed'
    try:
        yield from _stream_backend(backend,messages,generation,engine,control)
        status = 'complete'
    finally:
        if ledger:
            ledger.finish(ident,control.usage,'stopped' if control.stop.is_set() else status)


def _stream_backend(backend, messages, generation, engine, control):
    if backend.mode == 'local':
        prompt = backend.tokenizer.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=False)
        iterator = engine['stream_generate'](
            backend.model, backend.tokenizer, prompt, max_tokens=generation['max_tokens'],
            sampler=engine['make_sampler'](temp=generation['temperature'], top_p=generation['top_p']))
        try:
            for part in iterator:
                if control.stop.is_set():
                    return
                yield part.text, ''
        finally:
            iterator.close()
        return

    endpoint = backend.base_url
    if not endpoint.endswith('/chat/completions'):
        endpoint += '/chat/completions'
    url = urlsplit(endpoint)
    connection_cls = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
    connection = connection_cls(url.hostname, url.port, timeout=15)
    control.connection = connection
    payload = dict(model=backend.model, messages=messages, stream=True, **generation)
    payload['stream_options'] = {'include_usage': True}
    if backend.provider == 'qwen':
        payload.update(enable_thinking=backend.thinking_enabled, preserve_thinking=False)
        if backend.web_search_enabled:
            payload['enable_search'] = True
    try:
        if control.stop.is_set():
            return
        connection.request('POST', url.path + ('?' + url.query if url.query else ''),
                           json.dumps(payload, ensure_ascii=False).encode(),
                           {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + backend.api_key})
        if control.stop.is_set():
            return
        if connection.sock:
            connection.sock.settimeout(180)
            control.socket = connection.sock
        response = connection.getresponse()
        if response.status >= 400:
            detail = response.read(8192).decode('utf-8', errors='replace')
            try:
                detail = json.loads(detail).get('error', {}).get('message', '')
            except (ValueError, AttributeError):
                detail = ''
            raise ValueError(f'API 请求失败（HTTP {response.status}）：{backend._safe_error_text(detail)[:180]}')
        finished = False
        while not control.stop.is_set():
            line = response.readline(1024 * 1024)
            if not line:
                break
            if not line.startswith(b'data:'):
                continue
            data = line[5:].strip()
            if data == b'[DONE]':
                finished = True
                break
            event = json.loads(data)
            if isinstance(event.get('usage'),dict):
                control.usage = event['usage']
            if event.get('error'):
                raise ValueError(backend._safe_error_text(str(event['error']))[:200])
            for choice in event.get('choices', []):
                delta = choice.get('delta') or {}
                if delta.get('refusal'):
                    raise ValueError(backend._safe_error_text(str(delta['refusal']))[:200])
                yield backend._response_text(delta.get('content')), backend._response_text(delta.get('reasoning_content'))
                if choice.get('finish_reason'):
                    if choice['finish_reason'] not in ('stop', 'length'):
                        raise ValueError('模型未完成本次回复：' + str(choice['finish_reason']))
                    finished = True
            # The usage-only packet can arrive AFTER finish_reason, before [DONE].
        if not finished and not control.stop.is_set():
            raise ValueError('连接在回复完成前中断。已收到的内容已保留。')
    except Exception as error:
        if not control.stop.is_set():
            raise ValueError(backend._safe_error_text(str(error))[:240]) from None
    finally:
        connection.close()
        control.connection = None
        control.socket = None


class Generations:
    def __init__(self, web):
        self.web = web
        self.guard = threading.RLock()
        self.controls = {}

    @property
    def db(self):
        return self.web['conn']

    def snapshot(self, ident):
        row = self.db.execute('SELECT * FROM web_generations WHERE id=?', (ident,)).fetchone()
        return dict(row) if row else None

    def start(self, session_id, text='', attachments=None, ident=None, retry=None):
        ident = str(uuid.UUID(ident)) if ident else str(uuid.uuid4())
        with self.guard:
            previous = self.snapshot(ident)
            if previous:
                if previous['session_id'] != session_id:
                    raise ValueError('请求编号与会话不匹配')
                return previous
            if self.controls:
                raise ValueError('上一条回复仍在生成，请先停止或等待完成。')
            if not self.web['session_row'](session_id):
                raise ValueError('会话不存在')
            user_id = None
            if retry:
                old = self.snapshot(retry)
                if not old or old['session_id'] != session_id or old['status'] not in ('failed', 'stopped') or not old['user_id']:
                    raise ValueError('这条回复不能重试')
                user_id = old['user_id']
                latest = self.db.execute('SELECT MAX(id) FROM messages WHERE session_id=?', (session_id,)).fetchone()[0]
                if latest != user_id:
                    raise ValueError('这段对话已有后续消息，请在最新位置继续聊天。')
            self.db.execute('INSERT INTO web_generations(id,session_id,user_id,status) VALUES (?,?,?,?)',
                            (ident, session_id, user_id, 'running'))
            self.db.commit()
            control = Control()
            control.session_id, control.run_id, control.purpose = session_id, ident, 'chat'
            self.controls[ident] = control
            self.web['care'].interrupt()
            threading.Thread(target=self.run, args=(ident, text, attachments or [], control), daemon=True).start()
            return self.snapshot(ident)

    def update(self, ident, **fields):
        self.db.execute('UPDATE web_generations SET ' + ','.join(key+'=?' for key in fields) + ' WHERE id=?',
                        [*fields.values(), ident])
        self.db.commit()

    def run(self, ident, text, attachments, control):
        web, raw, reasoning = self.web, '', ''
        engine = web['engine']
        with web['app'].app_context():
            try:
                with web['generation_lock']:
                    run = self.snapshot(ident)
                    sid = run['session_id']
                    # Persist a user turn exactly once, even if connection/model setup fails.
                    if not run['user_id']:
                        stored = engine['attachment_display_text'](text, attachments)
                        uid = engine['save_message'](self.db, sid, 'user', stored)
                        self.update(ident, user_id=uid)
                        engine['store_attachments'](self.db, uid, sid, attachments)
                    else:
                        uid = run['user_id']
                        text = self.db.execute('SELECT content FROM messages WHERE id=?', (uid,)).fetchone()[0]
                    if control.stop.is_set():
                        self.update(ident, status='stopped')
                        return
                    backend = web['current_chat_backend']()
                    attached = engine['list_message_attachments'](self.db, uid)
                    error = engine['validate_attachments_for_backend'](attached, backend)
                    if error:
                        raise ValueError(error)
                    profile = engine['generation_settings_for_mode'](backend.mode)
                    history = engine['load_recent_messages_for_backend'](self.db, sid, backend)
                    memories = engine['retrieve_memories'](self.db, text)
                    prompt = engine['build_context'](engine['load_active_persona'](), history, memories,
                                                     engine['get_session_summary'](self.db, sid), backend)
                    last_update = 0
                    for content, thought in stream_backend(backend, prompt, profile, engine, control):
                        if control.stop.is_set():
                            break
                        raw += content
                        reasoning += thought
                        if time.monotonic() - last_update > .06:
                            self.update(ident, content=visible_text(raw, engine), reasoning=reasoning)
                            last_update = time.monotonic()
                    answer = visible_text(raw, engine, final=not control.stop.is_set())
                    # Serialize stop versus final commit so a stopped turn cannot become complete.
                    with self.guard:
                        if control.stop.is_set():
                            self.update(ident, status='stopped', content=answer, reasoning=reasoning)
                            return
                        if not answer.strip():
                            raise ValueError('模型没有返回正文，请检查模型设置后重试。')
                        cursor = self.db.execute('INSERT INTO messages(session_id,role,content,reasoning_content,created_at) VALUES (?,?,?,?,?)',
                                                 (sid, 'assistant', answer, reasoning, engine['now']()))
                        self.update(ident, status='complete', assistant_id=cursor.lastrowid, content=answer, reasoning=reasoning)
                    # Queue housekeeping; a new chat cancels housekeeping's model work.
                    try:
                        web['care'].enqueue(sid,backend)
                    except Exception:
                        pass
            except Exception as error:
                self.db.rollback()
                self.update(ident, status='stopped' if control.stop.is_set() else 'failed',
                            content=visible_text(raw, engine), reasoning=reasoning, error=str(error)[:300])
            finally:
                with self.guard:
                    self.controls.pop(ident, None)

    def decorate(self, sid, messages):
        runs = self.db.execute('SELECT * FROM web_generations WHERE session_id=? ORDER BY rowid', (sid,)).fetchall()
        latest = {row['user_id']:dict(row) for row in runs if row['user_id']}
        result = []
        last_message_id = max((m['id'] for m in messages), default=0)
        for message in messages:
            result.append(message)
            run = latest.get(message['id'])
            if not run or run['status'] == 'complete':
                continue
            result.append(dict(id='generation-'+run['id'], role='assistant', content=run['content'],
                               reasoning_content=run['reasoning'], created_at=message['created_at'], attachments=[],
                               generation_id=run['id'], generation_status=run['status'], generation_error=run['error'],
                               can_retry=run['user_id']==last_message_id and run['status'] in ('failed','stopped')))
        return result

    def register(self):
        app = self.web['app']

        @app.get('/api/generations/<ident>')
        def generation_status(ident):
            result = self.snapshot(ident)
            return jsonify(result) if result else (jsonify(error='回复任务不存在'),404)

        @app.get('/api/generations/<ident>/events')
        def generation_events(ident):
            if not self.snapshot(ident):
                return jsonify(error='回复任务不存在'),404
            def events():
                with app.app_context():
                    previous, heartbeat = '', 0
                    while True:
                        result = self.snapshot(ident)
                        if not result:
                            return
                        data = json.dumps(result, ensure_ascii=False)
                        if data != previous or time.monotonic()-heartbeat > 10:
                            yield data+'\n'
                            previous, heartbeat = data, time.monotonic()
                        if result['status'] in TERMINAL:
                            return
                        time.sleep(.06)
            return Response(events(), mimetype='application/x-ndjson', headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

        @app.post('/api/generations/<ident>/stop')
        def generation_stop(ident):
            with self.guard:
                result = self.snapshot(ident)
                if not result:
                    return jsonify(error='回复任务不存在'),404
                control = self.controls.get(ident)
                if control and result['status'] not in TERMINAL:
                    self.update(ident,status='stopping')
                    control.cancel()
            return jsonify(self.snapshot(ident))

        @app.post('/api/generations/<ident>/retry')
        def generation_retry(ident):
            previous = self.snapshot(ident)
            if not previous:
                return jsonify(error='回复任务不存在'),404
            try:
                return jsonify(self.start(previous['session_id'], ident=(request.get_json(silent=True) or {}).get('request_id'), retry=ident)),202
            except ValueError as error:
                return jsonify(error=str(error)),409

        @app.before_request
        def protect_active_session():
            if request.method not in ('DELETE','POST'):
                return
            if request.method == 'DELETE' or request.path == '/api/sessions/batch/delete':
                with self.guard:
                    if self.controls:
                        return jsonify(error='请等本次回复与记忆整理结束后再删除。'),409
