import { Evaluator, compileWorkflow, executeWorkflow, runWorkflow, rebuildWorkflowReport, DefinedBenchmark, DockerEnvironment, readProfileDirectory,
  runDockerCommand, parseConfigProfile, DirectoryReceiver } from "arsi-evaluator";
import type { WorkflowDocument, WorkflowCatalog, WorkflowStore, PluginFactory, PluginFactoryContext, ConfigProfile, ConfigTransportLookup, BenchmarkDefinition,
  DatasetRecordSource, EffectiveConfig, Environment, RunComponents } from "arsi-evaluator";

export async function consume(config: WorkflowDocument, definitions: WorkflowCatalog, store: WorkflowStore, components: RunComponents, factory: PluginFactory<"environment">,
  runtime: PluginFactoryContext, definition: BenchmarkDefinition, source: DatasetRecordSource) {
  const plan = compileWorkflow(config, definitions);
  const environment: Environment = await factory({}, runtime);
  const effective: EffectiveConfig | undefined = undefined;
  const lookup: ConfigTransportLookup = () => undefined;
  const profile: ConfigProfile = parseConfigProfile({ id: "fixture", benchmark: { name: "fixture" } });
  void new DefinedBenchmark(definition, source, { dockerExecutable: "docker" });
  void new DockerEnvironment();
  void new DirectoryReceiver("received", async () => true);
  void readProfileDirectory(new URL("./profiles/", import.meta.url));
  void runDockerCommand("docker", ["version"]);
  void effective; void lookup; void profile; void environment;
  void components;
  await executeWorkflow(plan, definitions, { store, signal: new AbortController().signal });
  await runWorkflow({ configPath: "experiment.yaml" });
  await new Evaluator().run({ configPath: "experiment.yaml" });
  await rebuildWorkflowReport("results");
}
