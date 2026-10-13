import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import base64


def unprotect(data):
    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source = Blob(len(data), buffer)
    target = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise RuntimeError('Windows cannot unlock this Notion session for the current user (error %s).' % ctypes.get_last_error())
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        kernel.LocalFree(target.pbData)


def main():
    parser = argparse.ArgumentParser(description='Import only the signed-in Notion desktop session into a local ignored file. Fully quit desktop Notion first.')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    profile = Path(os.environ['APPDATA']) / 'Notion'
    local = json.loads((profile / 'Local State').read_text(encoding='utf-8'))
    encrypted_key = base64.b64decode(local['os_crypt']['encrypted_key'])
    if not encrypted_key.startswith(b'DPAPI'):
        raise RuntimeError('Unsupported session encryption. Use a manual local session instead.')
    key = unprotect(encrypted_key[5:])
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    cookie = None
    user = None
    device_id = None
    browser_id = None
    for filename in [profile / 'Partitions' / 'notion' / 'Network' / 'Cookies', profile / 'Network' / 'Cookies']:
        if not filename.exists():
            continue
        try:
            connection = sqlite3.connect(filename.as_uri() + '?mode=ro', uri=True)
            with connection:
                rows = connection.execute("SELECT host_key, name, value, encrypted_value FROM cookies WHERE (host_key = '.notion.so' OR host_key = 'www.notion.so' OR host_key = '.notion.com' OR host_key = '.app.notion.com' OR host_key = 'app.notion.com') AND name IN ('token_v2', 'notion_user_id', 'device_id', 'notion_browser_id')").fetchall()
            connection.close()
        except sqlite3.OperationalError:
            raise RuntimeError('The Notion cookie file is locked. Fully quit desktop Notion, then retry.')
        for host, name, value, encrypted in rows:
            if not value and encrypted:
                if encrypted[:3] in (b'v10', b'v11'):
                    decoded = AESGCM(key).decrypt(encrypted[3:15], encrypted[15:], None)
                    if decoded.startswith(hashlib.sha256(host.encode()).digest()):
                        decoded = decoded[32:]
                elif encrypted.startswith(b'v20'):
                    raise RuntimeError('This session uses app-bound encryption and is not supported. No bypass attempted.')
                else:
                    decoded = unprotect(encrypted)
                value = decoded.decode('utf-8')
            if name == 'token_v2' and value:
                cookie = value
            if name == 'notion_user_id' and value:
                user = value
            if name == 'device_id' and value:
                device_id = value
            if name == 'notion_browser_id' and value:
                browser_id = value
    if not cookie:
        raise RuntimeError('No signed-in desktop Notion session found.')
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise RuntimeError('Output already exists. Keep or rename it before importing again.')
    out.write_text(json.dumps({'tokenV2': cookie, 'userId': user, 'deviceId': device_id, 'browserId': browser_id}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'imported': True, 'hasUserId': bool(user), 'output': str(out)}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
