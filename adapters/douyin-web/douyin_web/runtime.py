"""Runtime ownership only; no pipeline business configuration."""
import os
import re
import time
from pathlib import Path
from contextlib import contextmanager

class BrowserError(RuntimeError):
    pass

def runtime_paths():
    root=Path(os.environ.get('CRAWLER_RUNTIME_DIR',Path(__file__).resolve().parents[3]/'runtime'))
    return {'browser':Path(os.environ.get('XHS_BROWSER_CACHE',root/'browser'))}

def hidden_desktop_env():
    display=os.environ.get('CRAWLER_WAYLAND_DISPLAY','')
    runtime=Path(os.environ.get('XDG_RUNTIME_DIR','/run/user/'+str(os.getuid())))
    if not re.fullmatch(r'wayland-[0-9]+',display) or not (runtime/display).is_socket():
        raise BrowserError('HIDDEN_DESKTOP_UNAVAILABLE')
    return {'WAYLAND_DISPLAY':display,'DISPLAY':''}

@contextmanager
def lease(path, timeout=360):
    # Stable files + OS locks avoid Windows delete/read races. The OS releases
    # ownership on process exit; a leftover file does not mean a held lease.
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);start=time.monotonic()
    with path.open('a+b',buffering=0) as handle:
        if os.name=='nt':
            import msvcrt
            def acquire():
                handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
            def release():
                handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            def acquire():fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            def release():fcntl.flock(handle.fileno(),fcntl.LOCK_UN)
        while True:
            try:acquire();break
            except OSError:
                if time.monotonic()-start>timeout:raise TimeoutError('Evidence job lease is busy')
                time.sleep(.02)
        try:yield
        finally:release()
