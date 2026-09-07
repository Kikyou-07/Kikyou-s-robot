"""Provider-reported usage ledger. Never stores prompts, keys, or response text."""
import hashlib
import math
from datetime import datetime
from zoneinfo import ZoneInfo
from flask import jsonify, request

ZONE = ZoneInfo('Asia/Shanghai')


def token(value):
    return value if type(value) is int and value >= 0 else None


class Usage:
    def __init__(self, web):
        self.web = web
        with web['app'].app_context():
            self.db.executescript('''
              CREATE TABLE IF NOT EXISTS web_api_usage (
                id INTEGER PRIMARY KEY, day TEXT NOT NULL, time TEXT NOT NULL,
                model TEXT NOT NULL, provider TEXT NOT NULL, price_key TEXT NOT NULL,
                purpose TEXT NOT NULL, session_id INTEGER, run_id TEXT,
                status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
                reasoning_tokens INTEGER, cached_tokens INTEGER);
              CREATE INDEX IF NOT EXISTS usage_day ON web_api_usage(day);
              CREATE TABLE IF NOT EXISTS web_api_prices (
                price_key TEXT PRIMARY KEY, input_rate REAL NOT NULL, output_rate REAL NOT NULL);
            ''')
            self.db.execute("UPDATE web_api_usage SET status='interrupted' WHERE status='running'")
            self.db.commit()

    @property
    def db(self):
        return self.web['conn']

    def begin(self, backend, control):
        stamp = datetime.now(ZONE)
        key = hashlib.sha256((backend.base_url+'\n'+backend.model).encode()).hexdigest()
        cursor = self.db.execute('''INSERT INTO web_api_usage
          (day,time,model,provider,price_key,purpose,session_id,run_id,status)
          VALUES (?,?,?,?,?,?,?,?, 'running')''',
          (stamp.date().isoformat(), stamp.isoformat(timespec='seconds'), backend.model,
           backend.provider, key, getattr(control,'purpose','chat'),
           getattr(control,'session_id',None), getattr(control,'run_id',None)))
        self.db.commit()
        return cursor.lastrowid

    def finish(self, ident, usage, status):
        usage = usage if isinstance(usage,dict) else {}
        output_details = usage.get('completion_tokens_details') or {}
        input_details = usage.get('prompt_tokens_details') or {}
        output_details = output_details if isinstance(output_details,dict) else {}
        input_details = input_details if isinstance(input_details,dict) else {}
        self.db.execute('''UPDATE web_api_usage SET status=?,input_tokens=?,output_tokens=?,
          reasoning_tokens=?,cached_tokens=? WHERE id=?''',
          (status, token(usage.get('prompt_tokens')), token(usage.get('completion_tokens')),
           token(output_details.get('reasoning_tokens')), token(input_details.get('cached_tokens')), ident))
        self.db.commit()

    def register(self):
        @self.web['app'].get('/api/usage')
        def report():
            day = request.args.get('day') or datetime.now(ZONE).date().isoformat()
            try:
                if datetime.strptime(day,'%Y-%m-%d').strftime('%Y-%m-%d') != day:
                    raise ValueError()
            except ValueError:
                return jsonify(error='日期格式应为 YYYY-MM-DD'),400
            rows = [dict(row) for row in self.db.execute('SELECT * FROM web_api_usage WHERE day=? ORDER BY id DESC',(day,))]
            prices = {r['price_key']:dict(r) for r in self.db.execute('SELECT * FROM web_api_prices')}
            groups = {}
            for row in rows:
                group = groups.setdefault(row['price_key'],dict(price_key=row['price_key'],model=row['model'],provider=row['provider'],requests=0,unknown=0,input_tokens=0,output_tokens=0,reasoning_tokens=0,reasoning_unknown=0,cost=0,priced=0,price=prices.get(row['price_key'])))
                group['requests'] += 1
                known = row['input_tokens'] is not None and row['output_tokens'] is not None
                group['unknown'] += int(not known)
                group['reasoning_unknown'] += int(row['reasoning_tokens'] is None)
                for field in ('input_tokens','output_tokens','reasoning_tokens'):
                    group[field] += row[field] or 0
                price = group['price']
                row['cost'] = None
                if known and price:
                    row['cost'] = (row['input_tokens']*price['input_rate']+row['output_tokens']*price['output_rate'])/1000000
                    group['cost'] += row['cost']; group['priced'] += 1
            for group in groups.values():
                members = [row for row in rows if row['price_key']==group['price_key']]
                for field in ('input_tokens','output_tokens','reasoning_tokens'):
                    if not any(row[field] is not None for row in members):
                        group[field] = None
            return jsonify(day=day,timezone='Asia/Shanghai',requests=len(rows),
                chat=sum(r['purpose']=='chat' for r in rows),background=sum(r['purpose']!='chat' for r in rows),
                groups=list(groups.values()),recent=rows[:100],recent_limit=100)

        @self.web['app'].put('/api/usage/prices')
        def prices():
            data = request.get_json(silent=True) or {}
            key = data.get('price_key')
            if not isinstance(key,str) or not self.db.execute('SELECT 1 FROM web_api_usage WHERE price_key=?',(key,)).fetchone():
                return jsonify(error='请先选择有用量记录的模型'),400
            try:
                rates = [float(data[k]) for k in ('input_rate','output_rate')]
                if any(not math.isfinite(v) or v < 0 or v > 1000000 for v in rates):
                    raise ValueError()
            except (ValueError,TypeError,KeyError):
                return jsonify(error='单价应为非负数字（元 / 百万 Token）'),400
            self.db.execute('INSERT OR REPLACE INTO web_api_prices VALUES (?,?,?)',(key,*rates));self.db.commit()
            return jsonify(ok=True)
