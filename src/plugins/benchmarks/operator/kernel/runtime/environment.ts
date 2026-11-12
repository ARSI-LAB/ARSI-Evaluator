import { delimiter } from "node:path";
import { runtimeProcessEnvironment } from "../../../../../infrastructure/process/local.js";
import type { KernelExecOptions } from "./execution.js";

// CANN set_env.sh, Python environments and native/Triton compilers supply these
// settings on the host. Match individual names so unrelated credentials stay out.
const kernelRuntimeVariables = [
  "ASCEND_HOME_PATH", "ASCEND_TOOLKIT_HOME", "ASCEND_OPP_PATH", "ASCEND_CUSTOM_OPP_PATH",
  "ASCEND_AICPU_PATH", "TOOLCHAIN_HOME", "TBE_IMPL_PATH",
  "ASCEND_VISIBLE_DEVICES", "ASCEND_RT_VISIBLE_DEVICES", "ASCEND_DEVICE_ID", "DEVICE_ID", "KERNEL_NPU_DEVICE",
  "LD_LIBRARY_PATH", "LIBRARY_PATH", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "CMAKE_PREFIX_PATH", "CC", "CXX",
  "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "VIRTUAL_ENV", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE",
  "TRITON_CACHE_DIR", "TORCH_EXTENSIONS_DIR",
];

export function kernelProcessEnvironment(atomDir: string, options: Pick<KernelExecOptions, "env" | "device">): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const name of kernelRuntimeVariables) {
    const value = process.env[name];
    if (value !== undefined) settings[name] = value;
  }
  const env = runtimeProcessEnvironment({ ...settings, ...options.env });
  if (options.device !== undefined) env.KERNEL_NPU_DEVICE = String(options.device);
  env.PYTHONPATH = env.PYTHONPATH ? `${atomDir}${delimiter}${env.PYTHONPATH}` : atomDir;
  return env;
}
