# Kikyou Chat

一个本地优先、可自行部署的中文 AI 聊天网页。它把常用的对话功能放在一个轻量的界面里：会话管理、附件、流式回复、停止与重试、角色卡，以及由用户确认后才会生效的长期记忆。

Kikyou Chat 可以连接任意 OpenAI 兼容 API；在 Apple Silicon Mac 上，也可以运行本地 MLX 模型。

> 这是一个个人自托管工具，而不是已配置登录、权限管理和多租户隔离的在线服务。默认只监听本机地址。

## 功能一览

- **本地优先的数据设计**：聊天记录、附件、导出和 API 配置默认保存到你的设备，而不是源码目录。
- **两种模型来源**：支持 OpenAI 兼容 API，也支持 Apple Silicon 上的本地 MLX 模型。
- **流式对话体验**：回复逐段显示，可随时停止；失败或中断后可重新生成，避免重复发送用户消息。
- **会话与附件**：创建、搜索、导出和管理多段会话；可发送图片、PDF 和常见文本、Office 文件。
- **可控的长期记忆**：自动整理出的候选记忆需要你确认，支持忽略、撤销、手动添加和修正。
- **角色卡与外观**：内置多个可编辑角色卡，并提供浅色、深色和专注背景等界面选项。
- **用量记录**：在 API 模式下记录服务商返回的 Token 用量；不会保存 API Key 或提示词副本到用量表中。

## 适合谁使用？

- 想在自己的电脑上运行中文 AI 聊天界面的人；
- 希望聊天记录和模型配置与源码分离的人；
- 想接入已有 OpenAI 兼容服务，或在 Apple Silicon Mac 上运行本地模型的人；
- 想基于一个可阅读、可修改的 Python/Flask 项目继续开发的人。

## 快速开始

需要 Python 3.10 或更高版本。

```bash
git clone https://github.com/Kikyou-07/Kikyou-s-robot.git
cd Kikyou-s-robot

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python kikyou_web.py
```

然后在浏览器打开 <http://127.0.0.1:8765>。首次启动会自动创建一个本机数据目录和默认角色卡。

默认情况下，网页会提示你在“设置 → 聊天模型 → 配置 API”中填写自己的 API 地址、模型名和 API Key。可以参考 `examples/provider_config.example.json`，但**不要**把真实的 Key 提交到 Git。

### 修改端口或本机数据位置

默认数据目录为 `~/.kikyou-chat`。你可以在启动前设置环境变量：

```bash
KIKYOU_HOME=/path/to/kikyou-data KIKYOU_PORT=9000 python kikyou_web.py
```

完整示例见 `examples/kikyou.env.example`。

## 选择模型来源

| 方式 | 适用场景 | 需要准备什么 |
| --- | --- | --- |
| OpenAI 兼容 API | 最快开始，适用于多数服务商 | API 地址、模型名和 API Key |
| 本地 MLX 模型 | Apple Silicon Mac 上的离线或本地推理 | 本地模型目录和 MLX 依赖 |

如需使用本地 MLX 模型：

```bash
pip install -r requirements-local-macos.txt
KIKYOU_MODEL_PATH=/absolute/path/to/your-MLX-model python kikyou_web.py
```

进入网页设置后切换到“本地 Qwen”。若没有安装本地模型依赖，API 模式仍可独立使用；长期记忆检索会自动降级为关键词匹配。

## 数据、隐私与安全

运行时数据与源码严格分离，默认保存在 `~/.kikyou-chat`：

- `provider_config.json`：仅本机 API 配置和 Key；
- `kikyou_memory.db`、`attachments/`、`exports/`、`backups/`：本机聊天和文件数据；
- `persona.txt`、`personas/`：本机角色设定。

这些内容已经被 `.gitignore` 排除。提交前仍建议执行 `git diff --cached`，确认没有把个人数据或密钥放进暂存区。

使用 **API 模式** 时，当前对话内容和所附文件会发送给你配置的模型服务商。请在使用前确认该服务商的隐私政策、数据保留规则和计费方式。

> **不要直接暴露到公网。** 本项目默认监听 `127.0.0.1`，且没有登录和权限控制。若要部署到局域网或服务器，请先自行添加身份验证、HTTPS 和访问限制。

## 项目结构

```text
kikyou-chat/
├── kikyou_web.py        # Flask 网页入口
├── kikyou_chat.py       # 对话、存储、角色卡和记忆逻辑
├── kikyou_stream.py     # 流式生成、停止与重试
├── kikyou_care.py       # 后台整理和记忆确认
├── static/              # 网页样式与前端脚本
├── templates/           # 页面模板
├── examples/            # 无敏感信息的配置示例
└── LICENSE              # 开源许可证正文
```

## 参与贡献

欢迎提出 Issue、改进文档或提交 Pull Request。请勿在公开 Issue、提交记录或截图中包含 API Key、聊天导出、数据库、附件或其他私人内容；安全问题请通过仓库维护者的私密联系方式报告，详见 `SECURITY.md`。

## 发布自己的副本

如果你是从本项目打包版本开始发布，请创建一个空 GitHub 仓库后再执行：

```bash
git init -b main
git add README.md LICENSE SECURITY.md .gitignore requirements*.txt examples templates static kikyou_*.py
git diff --cached
git commit -m "Initial open-source release"
git remote add origin git@github.com:YOUR-USER/kikyou-chat.git
git push -u origin main
```

上传前请确认你拥有所有图片、文字和其他素材的再发布权利。

## 许可证

本项目采用 [MIT License](https://spdx.org/licenses/MIT.html)。完整许可证正文位于仓库根目录的 `LICENSE` 文件中。
