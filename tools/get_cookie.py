#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从本机浏览器里自动提取 chaoxing.com 的登录 cookie。

优势：不用手动复制，也不用每次重新导出。只要浏览器里还登录着，直接读。

支持：
  - Chromium 系（Chrome / Edge / 360 / QQ浏览器 / Brave）：DPAPI + AES-GCM 解密
  - Firefox：cookies.sqlite 明文读取

用法：
  python get_cookie.py            # 自动扫描所有浏览器并写入 cookie.txt
  python get_cookie.py --list     # 只列出找到的 cookie，不写文件
"""
import os
import sys
import json
import shutil
import sqlite3
import tempfile
import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIE_FILE = os.path.join(HERE, "cookie.txt")
DOMAIN_HINT = "chaoxing.com"

LOCAL = os.environ.get("LOCALAPPDATA", "")
APPDATA = os.environ.get("APPDATA", "")

# 各浏览器 User Data 根目录 -> 可能含 Cookies 的 profile 相对路径
CHROMIUM_BROWSERS = {
    "Chrome":  os.path.join(LOCAL, r"Google\Chrome\User Data"),
    "Edge":    os.path.join(LOCAL, r"Microsoft\Edge\User Data"),
    "Brave":   os.path.join(LOCAL, r"BraveSoftware\Brave-Browser\User Data"),
    "360极速":  os.path.join(LOCAL, r"360Chrome\Chrome\User Data"),
    "360安全":  os.path.join(LOCAL, r"360Chrome\Chrome\User Data"),
    "QQ浏览器": os.path.join(LOCAL, r"Tencent\QQBrowser\User Data"),
    "搜狗":     os.path.join(LOCAL, r"SogouExplorer\User Data"),
}

FIREFOX_PROFILES = os.path.join(APPDATA, r"Mozilla\Firefox\Profiles")


# ---------------------------------------------------------------- Chromium
def dpapi_unprotect(data: bytes) -> bytes:
    """调用 Windows DPAPI 解密（当前用户上下文，无需密码）。"""
    import ctypes
    import ctypes.wintypes as wt

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wt.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32

    blob_in = DATA_BLOB(len(data), ctypes.cast(ctypes.c_char_p(data),
                                               ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None,
                                       None, 0, ctypes.byref(blob_out)):
        raise OSError("CryptUnprotectData 失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def get_master_key(user_data_dir: str):
    """从 Local State 里取加密后的 master key 并解密。"""
    ls = os.path.join(user_data_dir, "Local State")
    if not os.path.exists(ls):
        return None
    with open(ls, encoding="utf-8") as f:
        state = json.load(f)
    enc = state.get("os_crypt", {}).get("encrypted_key")
    if not enc:
        return None
    import base64
    raw = base64.b64decode(enc)
    if raw[:5] == b"DPAPI":          # 前缀
        raw = raw[5:]
    return dpapi_unprotect(raw)


def decrypt_value(value: bytes, key: bytes):
    """解密单个 cookie。新版 Chrome 用 v10/v11 + AES-GCM；老版直接 DPAPI。"""
    if not value:
        return ""
    prefix = value[:3]
    if prefix in (b"v10", b"v11", b"v20"):
        if not key:
            return None
        # 优先用 cryptography（本机已装），退回 pycryptodome
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            return AESGCM(key).decrypt(value[3:15], value[15:], None).decode("utf-8", "replace")
        except ImportError:
            pass
        try:
            from Crypto.Cipher import AES           # pycryptodome
        except ImportError:
            raise RuntimeError("需要 cryptography 或 pycryptodome 来解密 Chrome cookie")
        nonce, payload = value[3:15], value[15:]
        tag, ct = payload[-16:], payload[:-16]
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        return cipher.decrypt_and_verify(ct, tag).decode("utf-8", "replace")
    # 老格式：整块 DPAPI
    try:
        return dpapi_unprotect(value).decode("utf-8", "replace")
    except Exception:
        return None


def shared_copy(src: str, dst: str) -> bool:
    """
    用 Win32 共享标志把被浏览器占用的文件复制出来。

    为什么不能直接 shutil.copy2 / open()：
      Chromium 持有 Cookies 文件时不带 FILE_SHARE_DELETE，普通打开会
      报 PermissionError / WinError 32。CreateFileW 显式声明
      share = READ|WRITE|DELETE 就能读。
    """
    import ctypes
    import ctypes.wintypes as wt

    GENERIC_READ = 0x80000000
    FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004  # read|write|delete
    OPEN_EXISTING = 3
    INVALID = ctypes.c_void_p(-1).value

    CreateFileW = ctypes.windll.kernel32.CreateFileW
    CreateFileW.restype = ctypes.c_void_p
    CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                            wt.DWORD, wt.DWORD, ctypes.c_void_p]

    h = CreateFileW(src, GENERIC_READ, FILE_SHARE_ALL, None,
                    OPEN_EXISTING, 0, None)
    if h == INVALID or h is None:
        return False
    try:
        total = 0
        buf = ctypes.create_string_buffer(1 << 20)
        read = wt.DWORD(0)
        with open(dst, "wb") as fo:
            while True:
                ok = ctypes.windll.kernel32.ReadFile(
                    ctypes.c_void_p(h), buf, len(buf),
                    ctypes.byref(read), None)
                if not ok or read.value == 0:
                    break
                fo.write(buf.raw[:read.value])
                total += read.value
        return total > 0
    finally:
        ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(h))


def open_db_copy(src: str):
    """
    把一个可能被占用的 sqlite 文件变成可查询的连接。
    返回 (connection, tmp_path)；失败返回 (None, None)。
    """
    tmp = os.path.join(tempfile.gettempdir(),
                       f"dsh_ck_{os.getpid()}_{os.path.basename(src)}.db")
    got = False
    try:
        shutil.copy2(src, tmp)
        got = True
    except Exception:
        got = shared_copy(src, tmp)
    if not got or not os.path.exists(tmp):
        # 最后再试一次：只读 immutable 模式直接查原文件
        try:
            uri = "file:///" + src.replace("\\", "/") + "?mode=ro&immutable=1"
            return sqlite3.connect(uri, uri=True), None
        except Exception:
            return None, None
    try:
        return sqlite3.connect(tmp), tmp
    except Exception:
        return None, None


def read_chromium(user_data_dir: str, label: str):
    """返回 {name: value}，只保留 chaoxing 域。"""
    if not os.path.isdir(user_data_dir):
        return None

    # 找所有 profile 下的 Cookies 文件
    # 注意：新版 Chromium 系把 cookie 放在 <Profile>\Network\Cookies，
    #      老版在 <Profile>\Cookies。两处都要找。
    candidates = []
    for entry in os.listdir(user_data_dir):
        base = os.path.join(user_data_dir, entry)
        if not os.path.isdir(base):
            continue
        for rel in (os.path.join("Network", "Cookies"), "Cookies"):
            p = os.path.join(base, rel)
            if os.path.exists(p):
                candidates.append(p)
                break
    if not candidates:
        return None

    key = None
    try:
        key = get_master_key(user_data_dir)
    except Exception as e:
        print(f"    [!] 取 master key 失败: {e}")

    jar = {}
    for cpath in candidates:
        con, tmp = open_db_copy(cpath)
        if con is None:
            print(f"    [!] 无法打开 {cpath}（浏览器占用且共享读失败）")
            continue
        try:
            rows = con.execute(
                "SELECT host_key, name, value, encrypted_value FROM cookies "
                "WHERE host_key LIKE ?", (f"%{DOMAIN_HINT}%",)).fetchall()
        except Exception as e:
            print(f"    [!] 查询失败: {e}")
            rows = []
        finally:
            con.close()
            if tmp:
                try:
                    os.remove(tmp)
                except Exception:
                    pass

        for host, name, val, enc in rows:
            v = val
            if not v and enc:
                try:
                    v = decrypt_value(enc, key)
                except Exception:
                    v = None
            if v:
                jar[name] = v
        if jar:
            break
    return jar or None


# ---------------------------------------------------------------- Firefox
def read_firefox():
    if not os.path.isdir(FIREFOX_PROFILES):
        return None
    for prof in os.listdir(FIREFOX_PROFILES):
        db = os.path.join(FIREFOX_PROFILES, prof, "cookies.sqlite")
        if not os.path.exists(db):
            continue
        tmp = os.path.join(tempfile.gettempdir(), f"ffck_{prof}.db")
        try:
            shutil.copy2(db, tmp)
        except Exception:
            if not shared_copy(db, tmp):
                continue
        try:
            con = sqlite3.connect(tmp)
            rows = con.execute(
                "SELECT name, value FROM moz_cookies WHERE host LIKE ?",
                (f"%{DOMAIN_HINT}%",)).fetchall()
            con.close()
        except Exception:
            continue
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass
        if rows:
            return {n: v for n, v in rows if v}
    return None


def main():
    want_write = "--list" not in sys.argv
    found = {}

    print("扫描 Chromium 系浏览器 ...")
    for label, path in CHROMIUM_BROWSERS.items():
        if not os.path.isdir(path):
            continue
        print(f"  [找到] {label}: {path}")
        jar = read_chromium(path, label)
        if jar:
            print(f"         -> 提取到 {len(jar)} 个 chaoxing cookie")
            found[label] = jar
        else:
            print("         -> 无 chaoxing cookie（可能没登录过）")

    print("扫描 Firefox ...")
    jar = read_firefox()
    if jar:
        print(f"  -> 提取到 {len(jar)} 个 chaoxing cookie")
        found["Firefox"] = jar
    else:
        print("  -> 无")

    if not found:
        print("\n[X] 没有从任何浏览器里找到 chaoxing 的 cookie。")
        print("    请确认：1) 浏览器里已登录学习通  2) 浏览器已完全关闭后重试")
        print("    或手动把 cookie 粘进 cookie.txt")
        return 1

    # 选 cookie 最多的那个浏览器
    label = max(found, key=lambda k: len(found[k]))
    jar = found[label]
    print(f"\n[OK] 采用 {label} 的 cookie，共 {len(jar)} 个：")
    for k, v in jar.items():
        show = v if len(v) <= 20 else v[:10] + "..." + v[-4:]
        print(f"     {k} = {show}")

    if want_write:
        line = "; ".join(f"{k}={v}" for k, v in jar.items())
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            f.write(line)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n[OK] 已写入 cookie.txt（{ts}，来自 {label}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
