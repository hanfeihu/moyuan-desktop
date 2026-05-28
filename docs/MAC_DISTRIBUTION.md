# macOS 安装包分发说明

如果用户下载后看到 `"Moyuan Desktop" 已损坏，无法打开`，通常不是应用代码损坏，而是 macOS Gatekeeper 拦截了未签名或未公证的下载包。

## 正式解决方案

对外分发的 macOS 安装包必须同时满足：

1. 使用 Apple Developer ID Application 证书签名。
2. 开启 Hardened Runtime。
3. 上传 Apple Notary 服务公证。
4. 使用公证后的 DMG / ZIP 作为下载入口。

项目已经预留配置：

- `apps/desktop/package.json`：macOS 打包启用 Hardened Runtime 和 entitlements。
- `apps/desktop/build/entitlements.mac.plist`
- `apps/desktop/build/entitlements.mac.inherit.plist`
- `.github/workflows/desktop-release.yml`：读取签名和公证 Secrets。

GitHub Actions 需要配置以下 Secrets 中的一组签名/公证材料：

```bash
CSC_LINK=
CSC_KEY_PASSWORD=

# 方式一：Apple ID
APPLE_ID=
APPLE_APP_SPECIFIC_PASSWORD=
APPLE_TEAM_ID=

# 或方式二：App Store Connect API Key
APPLE_API_KEY=
APPLE_API_KEY_ID=
APPLE_API_ISSUER=
```

`CSC_LINK` 可以是 Developer ID Application 证书的 base64，也可以是可下载的证书链接。证书密码放在 `CSC_KEY_PASSWORD`。

注意：Apple Development 证书只能用于本机/内测验证，不能解决普通用户下载后被 Gatekeeper 判定“已损坏”的问题。官网和 GitHub Release 面向外部分发时，必须使用 Developer ID Application 证书完成签名，并成功公证。

## 内测临时处理

如果只是给测试用户临时试用未签名包，可以让用户安装后执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Moyuan Desktop.app"
```

这只是内测绕过方式，不适合作为官网公开下载方案。公开下载必须签名和公证。

## 验证命令

本机验证签名：

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Moyuan Desktop.app"
spctl --assess --type execute --verbose "/Applications/Moyuan Desktop.app"
```

验证 DMG 公证：

```bash
spctl --assess --type open --verbose "apps/desktop/release/Moyuan-Desktop-*-mac-arm64.dmg"
```
