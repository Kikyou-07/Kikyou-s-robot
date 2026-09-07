# Kikyou Chat

一个本地优先的中文聊天网页：支持会话、附件、长期记忆确认、流式回复、停止与重试、角色卡，以及 OpenAI 兼容 API 或 Apple Silicon 上的本地 MLX 模型。

本仓库不包含任何聊天记录、数据库、附件、导出文件、API Key、个人角色卡或私人插画。首次运行时，这些内容会在本机数据目录中创建。

## 快速开始（推荐：API 模式）

需要 Python 3.10 或更高版本：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python kikyou_web.py
```

打开 <http://127.0.0.1:8765>，在“设置 → 聊天模型 → 配置 API”中填写自己的 OpenAI 兼容 API 地址、模型名和 API Key。密钥只会写入本机数据目录，不会进入仓库。

默认数据目录是 `~/.kikyou-chat`。如需隔离测试数据或更改端口：

```bash
KIKYOU_HOME=/path/to/kikyou-data KIKYOU_PORT=9000 python kikyou_web.py
```

可参考 [examples/provider_config.example.json](examples/provider_config.example.json)，但不要把真实 Key 提交到 Git。

> **安全提醒：** 默认只监听 `127.0.0.1`，且这个小工具没有登录机制。不要把它直接暴露到公网，也不要把 `KIKYOU_HOST` 改成 `0.0.0.0`；如确有局域网部署需求，请先自行加入身份验证和 HTTPS 反向代理。

## 本地 MLX 模型（macOS / Apple Silicon）

```bash
pip install -r requirements-local-macos.txt
KIKYOU_MODEL_PATH=/absolute/path/to/your-MLX-model python kikyou_web.py
```

随后在网页设置中切换到“本地 Qwen”。若未安装本地模型依赖，API 模式仍可独立运行；长期记忆会自动回退到关键词检索。

## 数据与隐私

运行时数据与源码严格分离：

- `provider_config.json`：仅本机 API 配置和 Key
- `kikyou_memory.db`、`attachments/`、`exports/`、`backups/`：仅本机聊天和文件数据
- `persona.txt`、`personas/`：仅本机角色设定

这些路径全部在 `.gitignore` 中。提交前请执行 `git diff --cached`，逐项确认不会公开私人材料。

## 开源发布前检查

1. 保持仓库中只有当前源码、`templates/`、`static/`、`examples/` 和文档。
2. 不要添加 `provider_config.json`、数据库、附件、导出记录或原始私人插画。
3. 确认你拥有所有要发布的图片、文字和其他素材的再发布权利。
4. 启用 GitHub 的 Secret Scanning / Push Protection，并检查暂存内容。

创建空 GitHub 仓库后：

```bash
git init -b main
git add README.md LICENSE SECURITY.md .gitignore requirements*.txt examples templates static kikyou_*.py
git diff --cached
git commit -m "Initial open-source release"
git remote add origin git@github.com:YOUR-USER/kikyou-chat.git
git push -u origin main
```

## License

[MIT](LICENSE)
