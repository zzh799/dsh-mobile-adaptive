# DeepSeek Harness 远程访问设置过程

### 1. Docker 部署 Harness

Harness 本机运行：

```text
http://127.0.0.1:3080
```

---

### 2. 开启 Tailscale

服务器安装并登录 Tailscale，启用：

* MagicDNS
* HTTPS
* Tailnet 内访问

不启用 `Tailscale Funnel`，避免公开到公网。

---

### 3. 增加本机 Nginx 反代

由于 Harness 远程访问部分接口存在限制，增加一层本机反向代理：

```text
127.0.0.1:3082
→
127.0.0.1:3080
```

Nginx 主要配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;

    proxy_http_version 1.1;
    proxy_set_header Host localhost:3080;
    proxy_set_header Origin http://localhost:3080;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

反代端口只监听：

```text
127.0.0.1
```

不对局域网或公网开放。

---

### 4. 配置 Tailscale Serve

将 Tailscale HTTPS 转发到 Nginx：

```bash
tailscale serve --https=8443 --bg http://127.0.0.1:3082
```

最终链路：

```text
Tailscale HTTPS :8443
        ↓
Nginx 127.0.0.1:3082
        ↓
Harness 127.0.0.1:3080
```

由于服务器原有 `443` 已被其他 Nginx 服务占用，因此这里使用 `8443`。

---

### 5. 检查状态

```bash
tailscale serve status
```

确认显示：

```text
tailnet only
```

同时确认未启用 Funnel。

---

### 6. 客户端访问

使用者：

1. 安装 Tailscale
2. 登录并加入同一个 Tailnet
3. 浏览器访问：

```text
https://<MagicDNS域名>:8443/
```

不需要：

* 公网端口映射
* 自签 CA
* VPN 回公司网络

最终即：

```text
Tailscale
→ HTTPS Serve
→ Nginx
→ DeepSeek Harness
```
