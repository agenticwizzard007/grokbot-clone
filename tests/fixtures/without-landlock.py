"""Test-only child boundary: make Linux Landlock syscalls return ENOSYS."""
import ctypes
import errno
import os
import sys

class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

class Program(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

# These Landlock syscall numbers are shared by Linux x86_64 and aarch64.
rules = [Filter(0x20, 0, 0, 0)]  # load seccomp_data.nr
for number in (444, 445, 446):
    rules.extend([Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.ENOSYS)])
rules.append(Filter(0x06, 0, 0, 0x7fff0000))  # allow all other syscalls
filters = (Filter * len(rules))(*rules)
program = Program(len(rules), filters)
libc = ctypes.CDLL(None, use_errno=True)
assert libc.prctl(38, 1, 0, 0, 0) == 0  # no_new_privs
assert libc.prctl(22, 2, ctypes.byref(program), 0, 0) == 0
assert libc.syscall(444, 0, 0, 1) == -1 and ctypes.get_errno() == errno.ENOSYS
os.execv(sys.argv[1], sys.argv[1:])
