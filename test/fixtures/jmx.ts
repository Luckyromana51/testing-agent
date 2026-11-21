/** JMeter test plans as JMeter 5.6 saves them, for the JMeter tests. */

export interface PlanOptions {
  host: string;
  port: number;
  threads?: number;
  loops?: number;
  /** Requests as [method, path]. */
  requests?: [string, string][];
  /** Extra test elements (XML) placed next to the requests, each followed by its hashTree. */
  extra?: string[];
  /** Extra text inside the first request (properties). */
  inRequest?: string;
  /** Use HTTP Request Defaults for the host instead of each request. */
  defaults?: boolean;
  scheduler?: { duration: number };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function request(method: string, p: string, o: PlanOptions, extra = ""): string {
  return `        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${esc(`${method} ${p}`)}">
          <stringProp name="HTTPSampler.domain">${o.defaults ? "" : esc(o.host)}</stringProp>
          <stringProp name="HTTPSampler.port">${o.defaults ? "" : o.port}</stringProp>
          <stringProp name="HTTPSampler.protocol">${o.defaults ? "" : "http"}</stringProp>
          <stringProp name="HTTPSampler.path">${esc(p)}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <stringProp name="HTTPSampler.method">${method}</stringProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
          <boolProp name="HTTPSampler.postBodyRaw">false</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
${extra}
        </HTTPSamplerProxy>
        <hashTree/>`;
}

export function jmxPlan(o: PlanOptions): string {
  const requests = (o.requests ?? [["GET", "/"]]).map(([m, p], i) => request(m, p, o, i === 0 ? (o.inRequest ?? "") : "")).join("\n");
  const defaults = o.defaults
    ? `      <ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="HTTP Request Defaults">
        <stringProp name="HTTPSampler.domain">${esc(o.host)}</stringProp>
        <stringProp name="HTTPSampler.port">${o.port}</stringProp>
        <stringProp name="HTTPSampler.protocol">http</stringProp>
        <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables">
          <collectionProp name="Arguments.arguments"/>
        </elementProp>
      </ConfigTestElement>
      <hashTree/>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Shop journey">
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
    </TestPlan>
    <hashTree>
${defaults}      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Shoppers">
        <intProp name="ThreadGroup.num_threads">${o.threads ?? 2}</intProp>
        <intProp name="ThreadGroup.ramp_time">1</intProp>
        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller">
          <stringProp name="LoopController.loops">${o.loops ?? 5}</stringProp>
          <boolProp name="LoopController.continue_forever">false</boolProp>
        </elementProp>
        <boolProp name="ThreadGroup.scheduler">${o.scheduler ? "true" : "false"}</boolProp>
        <stringProp name="ThreadGroup.duration">${o.scheduler?.duration ?? ""}</stringProp>
        <stringProp name="ThreadGroup.delay"></stringProp>
      </ThreadGroup>
      <hashTree>
${requests}
${(o.extra ?? []).map((x) => `${x}\n        <hashTree/>`).join("\n")}
        <ResultCollector guiclass="SummaryReport" testclass="ResultCollector" testname="Summary Report">
          <boolProp name="ResultCollector.error_logging">false</boolProp>
          <objProp>
            <name>saveConfig</name>
            <value class="SampleSaveConfiguration">
              <time>true</time>
              <latency>true</latency>
              <timestamp>true</timestamp>
              <success>true</success>
            </value>
          </objProp>
          <stringProp name="filename"></stringProp>
        </ResultCollector>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
}
