# 如何给这个任务提供学习通 Cookie

超星 `task.chaoxing.com` 必须登录才能访问。我有两条路拿到登录态，任选一条。

---

## 方式 A：自动提取（推荐 —— 不用手动复制）

我已经写好 `get_cookie.py`，它能直接解密 Edge/Chrome 的 cookie。

**唯一要求：Edge 必须完全退出。**

因为 Edge 运行时会独占 cookie 数据库文件，我读不到（已验证：共享读、只读、SQLite 只读模式全部失败）。

### 步骤

1. 保存好正在编辑的东西。
2. 关闭 Edge 所有窗口。
3. 确认后台没有残留：打开**任务管理器**（`Ctrl+Shift+Esc`），
   找到 `msedge.exe`，若有则**结束任务**。
4. 回到对话框告诉我「Edge 已关闭」。
5. 我执行：

   ```
   python get_cookie.py
   ```

   看到 `[OK] 已写入 cookie.txt` 就成了。

---

## 方式 B：手动复制 Cookie

不想关 Edge 就用这个。

1. Edge 里打开 <https://i.chaoxing.com> 并确认**已登录**。
2. 按 `F12` 打开开发者工具。
3. 切到 **网络 / Network** 面板，按 `F5` 刷新页面。
4. 在请求列表里点任意一条 `chaoxing.com` 的请求。
5. 右侧选 **标头 / Headers**，往下滚到
   **请求标头 / Request Headers**，找到 `Cookie:` 这一行。
6. 右键那一行的值 → 复制（很长，几百字符）。
7. 粘贴进 `cookie.txt`，整份替换掉里面的 `PASTE_COOKIE_HERE`。

> 关键 cookie：`JSESSIONID`、`_uid`、`uf`、`fid`、`vc3`、`p_auth_token`。
> 缺 `_uid`/`uf`/`vc3` 通常就进不去。

### 验证

```
python dsh_chaoxing.py cookie    # 列出解析到的 cookie
python dsh_chaoxing.py probe     # 必须显示 [已登录]
```

`probe` 显示 `[未登录]` 就是 cookie 不对或过期，重来一次。

---

## 安全提醒

- `cookie.txt` 等同于你的账号密码，**不要发给任何人、不要上传到网上**。
- 任务做完可以让我清空它。
