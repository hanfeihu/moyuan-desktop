# 登录注册与 Token 认证接口

本文档描述墨渊后台 API 的登录、注册和 Token 认证约定。生产入口经过 Nginx 反代：

- 外部地址：`http://codex.tminos.com:18080/admin-api`
- 服务内部地址：`http://127.0.0.1:14000/api/admin`

客户端、后台前端和第三方调用方应使用外部地址。下文路径均以外部地址为准。

## 认证规则

登录成功后，服务端返回明文 `token`。调用受保护接口时必须携带：

```http
Authorization: Bearer <token>
```

服务端也兼容备用请求头：

```http
x-moyuan-auth-token: <token>
```

生产约定：

- Token 只在登录/注册成功时返回一次。
- 服务端只保存 Token 的 SHA-256 哈希，不保存明文 Token。
- 员工 Token 默认有效期为 30 天，可通过 `SESSION_TTL_MS` 调整。
- 管理员 Token 默认有效期为 7 天，可通过 `ADMIN_SESSION_TTL_MS` 调整。
- Token 过期、缺失、错误或账号停用时返回 `401`。

## 员工端接口

### 发送邮箱验证码

```http
POST /auth/send-code
Content-Type: application/json
```

请求：

```json
{
  "email": "user@example.com"
}
```

成功响应：

```json
{
  "data": {
    "sent": true,
    "expiresIn": 600
  }
}
```

说明：

- 验证码有效期 10 分钟。
- 验证码目前保存在 API 进程内存中，服务重启后未使用验证码会失效。
- 邮件服务未启用或发送失败时返回 `500`。

常见错误：

```json
{ "error": "邮箱地址不正确" }
```

```json
{ "error": "验证码发送失败" }
```

### 注册并登录

```http
POST /auth/register
Content-Type: application/json
```

请求：

```json
{
  "email": "user@example.com",
  "code": "123456",
  "name": "张三"
}
```

成功响应：

```json
{
  "data": {
    "token": "session-token",
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "name": "张三",
      "status": "active",
      "tokenBudget": 0,
      "tokenUsed": 0,
      "promptTokens": 0,
      "completionTokens": 0,
      "skillTokens": 0,
      "createdAt": "2026-06-01T00:00:00.000Z",
      "lastLoginAt": "2026-06-01T00:00:00.000Z"
    }
  }
}
```

说明：

- 新用户默认额度为 `0`，需要管理员后台派发额度或用户充值。
- 如果邮箱已存在，注册接口会更新姓名、激活账号并重新登录。
- 验证码使用成功后立即失效。

常见错误：

```json
{ "error": "注册信息不完整" }
```

```json
{ "error": "验证码不正确或已过期" }
```

### 登录

```http
POST /auth/login
Content-Type: application/json
```

请求：

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

成功响应与注册接口一致：

```json
{
  "data": {
    "token": "session-token",
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "name": "张三",
      "status": "active",
      "tokenBudget": 10000000,
      "tokenUsed": 0,
      "promptTokens": 0,
      "completionTokens": 0,
      "skillTokens": 0,
      "createdAt": "2026-06-01T00:00:00.000Z",
      "lastLoginAt": "2026-06-01T00:00:00.000Z"
    }
  }
}
```

常见错误：

```json
{ "error": "登录信息不完整" }
```

```json
{ "error": "验证码不正确或已过期" }
```

```json
{ "error": "账号不存在，请先注册" }
```

### 获取当前员工

```http
GET /me
Authorization: Bearer <employee-token>
```

成功响应：

```json
{
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "name": "张三",
      "status": "active",
      "tokenBudget": 10000000,
      "tokenUsed": 1200,
      "promptTokens": 500,
      "completionTokens": 300,
      "skillTokens": 400,
      "createdAt": "2026-06-01T00:00:00.000Z",
      "lastLoginAt": "2026-06-01T00:00:00.000Z"
    }
  }
}
```

未登录或 Token 失效：

```json
{ "error": "请先登录" }
```

## 管理员接口

管理员 Token 与员工 Token 分开存储、分开校验。管理员 Token 只能访问后台管理接口，员工 Token 不能替代管理员 Token。

### 查询管理员初始化状态

```http
GET /admin-auth/state
```

成功响应：

```json
{
  "data": {
    "configured": true,
    "username": "admin"
  }
}
```

### 初始化管理员

仅首次部署使用。

```http
POST /admin-auth/setup
Content-Type: application/json
```

请求：

```json
{
  "username": "admin",
  "password": "至少 8 位密码"
}
```

成功响应：

```json
{
  "data": {
    "token": "admin-session-token",
    "username": "admin"
  }
}
```

如果管理员已存在：

```json
{ "error": "管理员账号已初始化" }
```

### 管理员登录

```http
POST /admin-auth/login
Content-Type: application/json
```

请求：

```json
{
  "username": "admin",
  "password": "管理员密码"
}
```

成功响应：

```json
{
  "data": {
    "token": "admin-session-token",
    "username": "admin"
  }
}
```

常见错误：

```json
{ "error": "请先初始化管理员账号" }
```

```json
{ "error": "管理员账号或密码不正确" }
```

### 获取当前管理员

```http
GET /admin-auth/me
Authorization: Bearer <admin-token>
```

成功响应：

```json
{
  "data": {
    "username": "admin"
  }
}
```

未登录或 Token 失效：

```json
{ "error": "请先登录管理员账号" }
```

## 调用示例

员工登录：

```bash
curl -X POST "http://codex.tminos.com:18080/admin-api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","code":"123456"}'
```

员工 Token 调用：

```bash
curl "http://codex.tminos.com:18080/admin-api/me" \
  -H "Authorization: Bearer <employee-token>"
```

管理员登录：

```bash
curl -X POST "http://codex.tminos.com:18080/admin-api/admin-auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password"}'
```

管理员 Token 调用：

```bash
curl "http://codex.tminos.com:18080/admin-api/users" \
  -H "Authorization: Bearer <admin-token>"
```

## 状态码约定

- `200`：请求成功。
- `400`：参数不完整、参数格式错误、验证码错误或过期。
- `401`：缺少 Token、Token 错误、Token 过期或账号不可用。
- `404`：登录账号不存在。
- `409`：管理员初始化状态冲突。
- `500`：邮件验证码发送失败或服务端异常。

## 数据持久化约定

登录会话、用户、管理员账号、密钥、订单和额度数据必须写入 PostgreSQL。生产环境禁止使用 JSON 文件作为运行时兜底。
