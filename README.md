# 即杏智绘 Photoshop

即杏智绘用于 Photoshop 局部修图、内容替换和参考图生成。当前版本为 **v1.10.0**，插件源码位于 `plugin/`。

- [下载最新版](https://github.com/qa963886265/x-image-photoshop/releases/latest)
- [功能与使用说明](plugin/README.md)
- [安装和更新](plugin/安装与使用说明.md)
- [更新日志](plugin/更新日志.md)
- [第三方素材说明](plugin/THIRD_PARTY_NOTICES.md)

## 发布与更新

版本号、`release/latest.json` 和对应 ZIP 安装包保持一致后，推送到 `main` 会触发现有 GitHub Actions 工作流，创建标签及 GitHub Release。

插件更新程序检查本仓库最新 Release，并从对应标签的源码 ZIP 中寻找插件目录。仓库内的 `plugin/manifest.json` 必须与 Release 版本一致。Release 同时提供可直接解压安装的 ZIP 附件，兼容使用附件的旧版本更新程序。

首次安装请下载 Release 附件；已有插件可点击左上角图标或版本号检查更新。
