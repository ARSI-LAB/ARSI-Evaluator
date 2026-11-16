import {mkdtemp, mkdir, copyFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "vitest";
import {startLocalProcess} from "../../src/infrastructure/process/local.js";

test.skipIf(process.platform !== "win32")("Windows Job Object launch resolves an extensionless executable through the supplied PATH", async () => {
  const root=await mkdtemp(join(tmpdir(),"local-process-path-"));
  try {
    const bin=join(root,"bin with spaces");
    await mkdir(bin);
    await copyFile(process.execPath,join(bin,"fixture tool.exe"));
    const handle=await startLocalProcess({executable:"fixture tool",args:["-e","process.stdout.write(process.argv[1])","quoted argument"],
      cwd:root,env:{Path:`"${bin}"`},inheritEnv:false,input:null},AbortSignal.timeout(15000));
    const collect=async (stream:AsyncIterable<Uint8Array>)=>{
      const chunks:Uint8Array[]=[];for await(const chunk of stream)chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    };
    const [out,err,exit]=await Promise.all([collect(handle.stdout),collect(handle.stderr),handle.done]);
    expect(err).toBe("");expect(exit.code).toBe(0);expect(out).toBe("quoted argument");
  } finally {
    expect(root.startsWith(join(tmpdir(),"local-process-path-"))).toBe(true);
    await rm(root,{recursive:true,force:true});
  }
},20000);

test.skipIf(process.platform !== "win32")("an unresolved Windows executable rejects startup instead of returning a launched job wrapper", async () => {
  let failure:unknown;
  try {
    const handle=await startLocalProcess({executable:"ember-no-such-executable-4c5636",args:[],cwd:process.cwd(),env:{Path:""},inheritEnv:false,input:null},AbortSignal.timeout(15000));
    await handle.done;
  } catch(error) {failure=error;}
  expect(failure).toMatchObject({code:"ENOENT"});
},20000);
