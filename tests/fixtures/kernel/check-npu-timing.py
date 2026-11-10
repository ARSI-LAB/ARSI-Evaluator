"""Exercise hardware selection without installing torch or querying devices."""
import importlib.util
import os
import sys
import types

calls = []
class Npu:
    available = False
    def is_available(self):
        return self.available
    def set_device(self, device):
        calls.append(device)
    def synchronize(self):
        pass

class Cuda:
    def __getattr__(self, name):
        raise AssertionError("NPU timing must not query CUDA: " + name)

npu = Npu()
sys.modules["torch"] = types.SimpleNamespace(npu=npu, cuda=Cuda())
sys.modules["torch_npu"] = types.ModuleType("torch_npu")
spec = importlib.util.spec_from_file_location("npu_timing", sys.argv[1])
timing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(timing)
assert timing.IS_NPU is True  # precision.py and external timers share this contract.
assert not calls, "Import must not select a device"

def forbidden():
    raise AssertionError("Workload must not execute without NPU")
try:
    timing.bench_kernel_ms(forbidden)
except RuntimeError as exc:
    assert "NPU is required" in str(exc)
else:
    raise AssertionError("Missing NPU must fail, not use CPU or CUDA")
assert not calls

npu.available = True
for key in ("ASCEND_RT_VISIBLE_DEVICES", "ASCEND_VISIBLE_DEVICES", "ASCEND_DEVICE_ID", "DEVICE_ID", "KERNEL_NPU_DEVICE"):
    os.environ.pop(key, None)
os.environ["KERNEL_NPU_DEVICE"] = "5"
os.environ["ASCEND_RT_VISIBLE_DEVICES"] = "3,5"
def profile(fn, **options):
    assert options == dict(warmup=2, active=7, prof_dir=None, keep_res=False, triton_only=True, audit=None, prepare=None)
    fn()
    return 1.25
timing._bench_npu_profiler = profile
executed = []
assert timing.bench_kernel_ms(lambda: executed.append(True), warmup=2, active=7, triton_only=True) == 1.25
assert calls == [1]
assert executed == [True]
