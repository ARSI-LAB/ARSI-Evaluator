import { expect, test } from "vitest";
import { findAscendCKernelName } from "../../src/plugins/benchmarks/operator/kernel/msprof-analysis.js";

function source(spec: string, declaration = "__global__ __aicore__ void device_kernel() {}") {
  return `from runtime import AscendCOp, LaunchSpec
_SRC = r'''${declaration}'''
_SPEC = ${spec}
_OP = AscendCOp("extension_name", _SRC, _SPEC)
`;
}

test.each([
  'LaunchSpec(name="device_kernel", block_dim=32)',
  "LaunchSpec('device_kernel', block_dim=32)",
  'LaunchSpec(\n    name = "device_kernel",\n    block_dim=32,\n)',
  'LaunchSpec(name="device_kernel")\n_SECOND = LaunchSpec(name="device_kernel")',
])("AscendC profiling resolves a unique matching static spec: %s", spec => {
  expect(findAscendCKernelName(source(spec))).toBe("device_kernel");
});

test.each([
  '__global__ void device_kernel() {}',
  'extern "C" __global__\n__aicore__ void\ndevice_kernel() {}',
  '__global__ __aicore__ void unused_kernel() {}\n__global__ __aicore__ void device_kernel() {}',
])("AscendC selection matches the spec instead of the first device declaration", declaration => {
  expect(findAscendCKernelName(source('LaunchSpec(name="device_kernel")', declaration))).toBe("device_kernel");
});

test.each([
  'LaunchSpec(name="other_kernel")',
  'LaunchSpec(name=kernel_name)',
  'LaunchSpec(name="device_kernel" + suffix)',
  'LaunchSpec(name=f"device_kernel")',
  'LaunchSpec(name="device_kernel")\n_OTHER = LaunchSpec(name="other_kernel")',
  'LaunchSpec(name="device_kernel")\n_OTHER = LaunchSpec(name=kernel_name)',
  'LaunchSpec(name="device_kernel")\n_OTHER = LaunchSpec(name="device_kernel" + suffix)',
  'LaunchSpec(num_tensors=2, name="device_kernel")',
  'LaunchSpec(name="device_kernel-invalid")',
])("AscendC profiling does not guess ambiguous or unsupported names: %s", spec => {
  expect(findAscendCKernelName(source(spec))).toBeUndefined();
});

test.each([
  'void device_kernel() {}',
  '__aicore__ void device_kernel() {}',
  '__global__ __aicore__ void device_kernel_extra() {}',
  '',
])("AscendC spec requires a matching global device declaration", declaration => {
  expect(findAscendCKernelName(source('LaunchSpec(name="device_kernel")', declaration))).toBeUndefined();
});

test("AscendC imports alone do not identify a runtime entry", () => {
  const input = source('LaunchSpec(name="device_kernel")');
  expect(findAscendCKernelName(input.replace('_OP = AscendCOp("extension_name", _SRC, _SPEC)', ''))).toBeUndefined();
  expect(findAscendCKernelName(input.replace('LaunchSpec(name="device_kernel")', 'None'))).toBeUndefined();
  expect(findAscendCKernelName('@triton.jit\ndef triton_kernel(x): pass\n')).toBeUndefined();
});
