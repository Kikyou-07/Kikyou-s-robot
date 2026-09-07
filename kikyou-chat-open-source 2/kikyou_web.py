"""桔梗本地网页界面：与 kikyou_chat.py 共用模型和 SQLite 数据库。"""
from __future__ import annotations

import threading
import sqlite3
import os
from pathlib import Path

from flask import Flask, jsonify, request, send_file, render_template, make_response, g
from werkzeug.local import LocalProxy
from kikyou_stream import Generations, initialize, Control, stream_backend
from kikyou_usage import Usage
from kikyou_care import Care, initialize_care


# Source files live beside this module; user data is configured by
# KIKYOU_HOME inside kikyou_chat.py and never belongs in the repository.
ROOT = Path(__file__).resolve().parent
CHAT_SCRIPT = ROOT / "kikyou_chat.py"
HOST = os.environ.get("KIKYOU_HOST", "127.0.0.1")
PORT = int(os.environ.get("KIKYOU_PORT", "8765"))


def load_engine():
    """复用终端版的数据库、记忆和清理逻辑，但不启动其命令行主循环。"""
    source = CHAT_SCRIPT.read_text(encoding="utf-8")
    marker = "# =========================\n# 初始化与主循环\n# ========================="
    prefix = source.split(marker, 1)[0]
    # MLX 会在 import 时请求 Metal；网页端直到发送首条消息才需要它。
    prefix = prefix.replace("from mlx_lm import load\n", "")
    prefix = prefix.replace("from mlx_lm.generate import stream_generate\n", "")
    prefix = prefix.replace("from mlx_lm.sample_utils import make_sampler\n", "")
    namespace = {"__name__": "kikyou_web_engine"}
    exec(compile(prefix, str(CHAT_SCRIPT), "exec"), namespace)
    return namespace


engine = load_engine()
app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))
app.config["MAX_CONTENT_LENGTH"] = engine["MAX_REQUEST_BYTES"]
generation_lock = threading.Lock()

conn = engine["init_db"]()
engine["backup_database"](conn)
initialize(conn)
initialize_care(conn)
conn.close()


def web_connection():
    if 'db' not in g:
        g.db = sqlite3.connect(engine['DB_PATH'], timeout=30)
        g.db.row_factory = sqlite3.Row
    return g.db


conn = LocalProxy(web_connection)


@app.teardown_appcontext
def close_web_connection(_error):
    db = g.pop('db', None)
    if db is not None:
        db.close()


persona = engine["load_active_persona"]()
model = None
tokenizer = None
local_backend = None


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify(error=f"附件总大小请控制在 {engine['MAX_TOTAL_ATTACHMENT_BYTES'] // 1024 // 1024} MB 以内"), 413


def ensure_chat_model():
    """网页先打开；仅在第一次发送消息时加载 9B 聊天模型。"""
    global model, tokenizer, local_backend
    if local_backend is None:
        try:
            from mlx_lm import load
            from mlx_lm.generate import stream_generate
            from mlx_lm.sample_utils import make_sampler
        except ImportError as error:
            raise engine["ProviderError"](
                "本地 MLX 模式尚未安装。请安装 requirements-local-macos.txt，"
                "或在网页设置中先配置 API 模式。"
            ) from error
        print("正在加载桔梗聊天模型……")
        model, tokenizer = load(engine["MODEL_PATH"])
        im_end_id = tokenizer.convert_tokens_to_ids("<|im_end|>")
        tokenizer.eos_token_ids = {im_end_id}
        engine["stream_generate"] = stream_generate
        engine["make_sampler"] = make_sampler
        local_backend = engine["LocalChatBackend"](model, tokenizer)
    return local_backend


def current_chat_backend():
    config = engine["load_provider_config"]()
    if config["mode"] == "api":
        return engine["ApiChatBackend"](config["api"])
    return ensure_chat_model()


def session_row(session_id):
    return conn.execute(
        "SELECT id, title, started_at, summary FROM sessions WHERE id = ?", (session_id,)
    ).fetchone()


def serialize_session(row):
    if "message_count" in row.keys():
        count, latest = row["message_count"], row["latest_at"]
    else:
        stats = conn.execute(
            "SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM messages WHERE session_id = ?",
            (row["id"],),
        ).fetchone()
        count, latest = stats["count"], stats["latest"]
    return {
        "id": row["id"], "title": row["title"], "started_at": row["started_at"],
        "latest_at": latest or row["started_at"],
        "message_count": count, "summary": row["summary"] or "",
    }


def list_sessions(query=""):
    # 最近继续过的旧对话也排在前面；一次聚合，避免逐会话查询统计。
    query = query.strip()
    sql = """SELECT s.id, s.title, s.started_at, s.summary,
                    COALESCE(stats.message_count, 0) AS message_count,
                    COALESCE(stats.latest_at, s.started_at) AS latest_at
             FROM sessions s
             LEFT JOIN (SELECT session_id, COUNT(*) AS message_count,
                               MAX(created_at) AS latest_at FROM messages GROUP BY session_id
                       ) stats ON stats.session_id = s.id"""
    params = []
    if query:
        like = f"%{query}%"
        sql += """ WHERE s.title LIKE ? COLLATE NOCASE OR s.summary LIKE ? COLLATE NOCASE
                    OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id
                               AND m.content LIKE ? COLLATE NOCASE)"""
        params = [like, like, like]
    rows = conn.execute(sql + " ORDER BY latest_at DESC, s.id DESC", params).fetchall()
    return [serialize_session(row) for row in rows]


def list_messages(session_id):
    if not session_row(session_id):
        return None
    rows = conn.execute(
        "SELECT id, role, content, reasoning_content, created_at "
        "FROM messages WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall()
    messages = []
    for row in rows:
        item = dict(row)
        item['memory_excluded'] = bool(conn.execute('SELECT 1 FROM web_memory_excluded WHERE message_id=?', (row['id'],)).fetchone())
        attachments = []
        for attachment_row in engine["list_message_attachments"](conn, row["id"]):
            attachment = engine["public_attachment"](attachment_row)
            attachment["url"] = f"/api/attachments/{attachment['id']}"
            attachment["download_url"] = attachment["url"] + "?download=1"
            attachments.append(attachment)
        item["attachments"] = attachments
        messages.append(item)
    return generations.decorate(session_id, messages)


def list_memories(query=""):
    query = query.strip()
    if query:
        rows = engine["retrieve_memories"](conn, query, 50)
    else:
        rows = conn.execute(
            "SELECT * FROM memories ORDER BY importance DESC, updated_at DESC LIMIT 50"
        ).fetchall()
    return [dict(row) for row in rows]


def recall(query):
    query_terms = engine["keywords"](query)
    engine["ensure_memory_embeddings"](conn)
    semantic = engine["semantic_scores"](conn, query)
    results = []
    for row in conn.execute("SELECT * FROM memories"):
        terms = engine["keywords"](" ".join((row["memory_key"], row["content"], row["tags"])))
        overlap = query_terms & terms
        keyword = len(overlap) / max(1, len(query_terms)) if query_terms else 0
        semantic_score = semantic.get(row["id"], 0)
        if not overlap and semantic_score < engine["SEMANTIC_MIN_SIMILARITY"]:
            continue
        total = semantic_score * 7 + keyword * 6 + row["importance"] * .25 + min(len(overlap), 3) * .35
        results.append({
            "id": row["id"], "content": row["content"], "importance": row["importance"],
            "semantic": round(semantic_score, 3), "keywords": sorted(overlap), "score": round(total, 2),
        })
    return sorted(results, key=lambda item: item["score"], reverse=True)[:engine["MEMORY_RETRIEVE_LIMIT"]]


def generate_reply(session_id, text, attachments=None):
    global persona
    attachments = attachments or []
    care.interrupt()
    with generation_lock:
        # 角色卡选择保存在本机配置中；每轮重新取一次，终端切换后网页也能接上。
        persona = engine["load_active_persona"]()
        if not session_row(session_id):
            return None, "会话不存在。"
        try:
            backend = current_chat_backend()
            generation = engine["generation_settings_for_mode"](getattr(backend, "mode", "local"))
        except (engine["ProviderError"], ValueError) as error:
            return None, str(error)
        attachment_error = engine["validate_attachments_for_backend"](attachments, backend)
        if attachment_error:
            return None, attachment_error
        stored_text = engine["attachment_display_text"](text, attachments)
        message_id = engine["save_message"](conn, session_id, "user", stored_text)
        try:
            stored_attachments = engine["store_attachments"](conn, message_id, session_id, attachments)
        except ValueError as error:
            conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
            conn.commit()
            return None, str(error)
        history = engine["load_recent_messages_for_backend"](conn, session_id, backend)
        memories = engine["retrieve_memories"](conn, text or stored_text)
        summary = engine["get_session_summary"](conn, session_id)
        try:
            prompt_messages = engine["build_context"](persona, history, memories, summary, backend)
            control = Control()
            control.session_id = session_id
            parts = list(stream_backend(backend,prompt_messages,generation,engine,control))
            response = dict(content=''.join(p[0] for p in parts),reasoning_content=''.join(p[1] for p in parts))
        except (engine["ProviderError"], ValueError) as error:
            return None, str(error)
        raw = response["content"]
        reasoning_content = str(response.get("reasoning_content", "") or "").strip()
        answer = engine["remove_action_descriptions"](engine["remove_thinking_process"](raw))
        engine["save_message"](conn, session_id, "assistant", answer, reasoning_content)
        notices = []
        care.enqueue(session_id,backend)
        serialized_attachments = []
        for attachment_row in stored_attachments:
            attachment = engine["public_attachment"](attachment_row)
            attachment["url"] = f"/api/attachments/{attachment['id']}"
            attachment["download_url"] = attachment["url"] + "?download=1"
            serialized_attachments.append(attachment)
        return {
            "answer": answer,
            "reasoning_content": reasoning_content,
            "thinking_enabled": bool(response.get("thinking_enabled", False)),
            "web_search_enabled": bool(response.get("web_search_enabled", False)),
            "notices": notices,
            "session": serialize_session(session_row(session_id)),
            "user_attachments": serialized_attachments,
        }, None


@app.get("/")
def index():
    # 页面结构、样式和交互各只有一个来源，避免多轮覆盖导致遮挡或布局冲突。
    assets = (
        "chat.css", "theme.css", "chat.js", "provider.js", "attachments.js",
        "streaming.js", "memory-ui.js", "usage.js", "theme-icon.svg",
        "theme-placeholder.svg", "chat-black-cat-avatar-selected.png",
    )
    version = max((ROOT / "static" / name).stat().st_mtime_ns for name in assets)
    response = make_response(render_template("chat.html", asset_version=version))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/sessions")
def api_sessions():
    return jsonify(list_sessions(request.args.get("q", "")))


@app.post("/api/sessions")
def api_new_session():
    payload = request.get_json(silent=True) or {}
    title = engine["clean_title"](payload.get("title", "")) or "新对话"
    session_id = engine["create_session"](conn, title)
    return jsonify(serialize_session(session_row(session_id))), 201


@app.get("/api/sessions/<int:session_id>/messages")
def api_messages(session_id):
    messages = list_messages(session_id)
    if messages is None:
        return jsonify(error="会话不存在"), 404
    return jsonify({"session": serialize_session(session_row(session_id)), "messages": messages})


@app.get("/api/sessions/<int:session_id>/summary")
def api_session_summary(session_id):
    row = session_row(session_id)
    if not row:
        return jsonify(error="会话不存在"), 404
    return jsonify(summary=row["summary"] or "")


@app.get("/api/personas")
def api_personas():
    return jsonify(engine["public_persona_config"]())


@app.put("/api/persona")
def api_select_persona():
    global persona
    try:
        status = engine["set_active_persona"]((request.get_json(silent=True) or {}).get("id"))
    except ValueError as error:
        return jsonify(error=str(error)), 400
    persona = engine["load_active_persona"]()
    return jsonify(
        message=f"已切换为{status['active_label']}；下一句回复会使用新设定。",
        **status,
    )


@app.post("/api/persona/reload")
def api_reload_persona():
    global persona
    persona = engine["load_active_persona"]()
    status = engine["public_persona_config"]()
    return jsonify(
        message=f"{status['active_label']}已重新读取；下一句回复会使用新设定。",
        **status,
    )


@app.get("/api/provider")
def api_provider():
    """只返回可展示的状态，绝不将 API Key 发给浏览器。"""
    return jsonify(engine["public_provider_config"]())


@app.put("/api/provider")
def api_update_provider():
    try:
        status = engine["update_provider_config"](request.get_json(silent=True) or {})
    except ValueError as error:
        return jsonify(error=str(error)), 400
    return jsonify(status)


@app.patch("/api/sessions/<int:session_id>")
def api_rename_session(session_id):
    title = (request.get_json(silent=True) or {}).get("title", "")
    if not engine["rename_session"](conn, session_id, title):
        return jsonify(error="标题不能为空或会话不存在"), 400
    return jsonify(serialize_session(session_row(session_id)))


@app.delete("/api/sessions/<int:session_id>")
def api_delete_session(session_id):
    if not engine["delete_session"](conn, session_id):
        return jsonify(error="会话不存在"), 404
    return "", 204


def batch_session_ids(payload):
    """只接受去重后的正整数会话编号，避免批量操作误伤其它记录。"""
    raw_ids = payload.get("ids", [])
    if not isinstance(raw_ids, list):
        return []
    ids = []
    for value in raw_ids:
        if isinstance(value, bool):
            continue
        try:
            session_id = int(value)
        except (TypeError, ValueError):
            continue
        if session_id > 0 and session_id not in ids:
            ids.append(session_id)
    return ids


@app.post("/api/sessions/batch/export")
def api_batch_export_sessions():
    ids = batch_session_ids(request.get_json(silent=True) or {})
    if not ids:
        return jsonify(error="请至少选择一个会话"), 400
    exported = []
    for session_id in ids:
        path = engine["export_session"](conn, session_id)
        if path:
            exported.append({"id": session_id, "path": str(path)})
    if not exported:
        return jsonify(error="所选会话不存在"), 404
    return jsonify(exported=exported, skipped=len(ids) - len(exported))


@app.post("/api/sessions/batch/delete")
def api_batch_delete_sessions():
    ids = batch_session_ids(request.get_json(silent=True) or {})
    if not ids:
        return jsonify(error="请至少选择一个会话"), 400
    deleted = [session_id for session_id in ids if engine["delete_session"](conn, session_id)]
    if not deleted:
        return jsonify(error="所选会话不存在"), 404
    return jsonify(deleted=deleted, skipped=len(ids) - len(deleted))


@app.post("/api/sessions/<int:session_id>/export")
def api_export(session_id):
    path = engine["export_session"](conn, session_id)
    if not path:
        return jsonify(error="会话不存在"), 404
    return jsonify(path=str(path))


@app.post("/api/sessions/<int:session_id>/messages")
def api_send_message(session_id):
    if request.mimetype == "multipart/form-data":
        raw_text = request.form.get("content", "")
        files = [item for item in request.files.getlist("attachments") if item and item.filename]
        if len(files) > engine["MAX_ATTACHMENTS_PER_MESSAGE"]:
            return jsonify(error=f"一次最多添加 {engine['MAX_ATTACHMENTS_PER_MESSAGE']} 个附件"), 400
        attachments = []
        total_bytes = 0
        try:
            for item in files:
                data = item.read()
                total_bytes += len(data)
                if total_bytes > engine["MAX_TOTAL_ATTACHMENT_BYTES"]:
                    raise ValueError(f"附件总大小请控制在 {engine['MAX_TOTAL_ATTACHMENT_BYTES'] // 1024 // 1024} MB 以内")
                attachments.append(engine["prepare_attachment"](item.filename, item.mimetype, data))
        except ValueError as error:
            return jsonify(error=str(error)), 400
        text = str(raw_text or "").strip()
    else:
        payload = request.get_json(silent=True) or {}
        text = str(payload.get("content", "") or "").strip()
        attachments = []
    if not text and not attachments:
        return jsonify(error="请输入消息或添加附件"), 400
    stream_requested = request.form.get('stream') if request.mimetype == 'multipart/form-data' else payload.get('stream')
    if stream_requested:
        ident = request.form.get('request_id') if request.mimetype == 'multipart/form-data' else payload.get('request_id')
        try:
            return jsonify(generations.start(session_id, text, attachments, ident=ident)), 202
        except ValueError as error:
            return jsonify(error=str(error)), 409
    result, error = generate_reply(session_id, text, attachments)
    if error:
        return jsonify(error=error), (404 if error == "会话不存在。" else 502)
    return jsonify(result)


@app.get("/api/attachments/<int:attachment_id>")
def api_attachment(attachment_id):
    attachment = engine["get_attachment"](conn, attachment_id)
    if not attachment:
        return jsonify(error="附件不存在"), 404
    try:
        path = engine["attachment_storage_path"](attachment)
    except ValueError:
        return jsonify(error="附件路径无效"), 404
    if not path.is_file():
        return jsonify(error="附件文件已不存在"), 404
    download = request.args.get("download") == "1"
    return send_file(
        path,
        mimetype=attachment["mime_type"],
        as_attachment=download,
        download_name=attachment["original_name"],
        conditional=True,
        max_age=0,
    )


@app.get("/api/memories")
def api_memories():
    return jsonify(list_memories(request.args.get("q", "")))


@app.patch("/api/memories/<int:memory_id>")
def api_edit_memory(memory_id):
    payload = request.get_json(silent=True) or {}
    if 'content' in payload:
        content = str(payload['content']).strip()
        if not content or len(content)>280:
            return jsonify(error='请填写 1–280 字的记忆内容'),400
        with care.guard:
            row = engine['get_memory'](conn,memory_id)
            if not row:
                return jsonify(error='记忆不存在'),404
            care.changed()
            if row['content'] != content:
                engine['archive_memory_revision'](conn,row,'用户纠正记忆')
                conn.execute('INSERT OR IGNORE INTO web_memory_suppressed VALUES (?,?)',(care.fingerprint(row['content']),row['content']))
                conn.execute('UPDATE memories SET content=?,updated_at=? WHERE id=?',(content,engine['now'](),memory_id))
                conn.commit()
    if "importance" in payload and not engine["edit_memory_importance"](conn, memory_id, int(payload["importance"])):
        return jsonify(error="重要度应在 1 到 10"), 400
    row = engine["get_memory"](conn, memory_id)
    return jsonify(dict(row)) if row else (jsonify(error="记忆不存在"), 404)


@app.delete("/api/memories/<int:memory_id>")
def api_delete_memory(memory_id):
    with care.guard:
        row = engine['get_memory'](conn,memory_id)
        if not row:
            return jsonify(error='记忆不存在'),404
        care.changed()
        conn.execute('INSERT OR IGNORE INTO web_memory_suppressed VALUES (?,?)',(care.fingerprint(row['content']),row['content']))
        engine['delete_memory'](conn,memory_id)
    return "", 204


@app.post("/api/recall")
def api_recall():
    query = (request.get_json(silent=True) or {}).get("query", "").strip()
    if not query:
        return jsonify(error="请输入测试问题"), 400
    return jsonify(recall(query))


usage = Usage(globals())
engine['usage_ledger'] = usage
usage.register()
generations = Generations(globals())
care = Care(globals())
care.register()
generations.register()


if __name__ == "__main__":
    print(f"桔梗网页已启动：http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
