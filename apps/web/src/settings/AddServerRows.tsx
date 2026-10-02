// SPDX-License-Identifier: AGPL-3.0-only
// Add a tool server as a page, in the settings pages' rows: the agent whose
// config takes it, its name, a command or an address, where it goes, then its
// variables or headers, each value masked and held here alone until the host
// takes it once and writes it into that agent's own file. The file it lands in
// stands beside Add server, following the agent and where, and the host's
// refusal under it.
import { XIcon } from "lucide-react";
import { useState } from "react";
import { MCP_AGENTS, agentName } from "@wsp/catalog";
import { commandWords, unclosedQuoteRefusal, type AgentsProject, type AgentsReport, type ServerAdd } from "@wsp/protocol";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { AGENTS_LIST_WORDS as W, inProject, pickOf, whereNow, type ProjectPick } from "../components/agents/agentsRows.js";
import type { AddFormProps } from "../components/agents/kinds/kind.js";
import { AddButton } from "../components/ui/add-button.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { cn, errorText } from "../lib/utils.js";
import { FACT } from "./format.js";
import { CARD_INSET, ROW_FIELD, ROW_FLOOR, SELECT_WIDTH } from "./layout.js";
import { Card, Line, Row } from "./rows.js";
import { RefusalSlot } from "./sheetParts.js";

type Road = "command" | "address";

interface Pair {
  readonly id: number;
  readonly name: string;
  readonly value: string;
}

/** The agents there whose config wsp writes servers into, in the catalog's order. */
const serverAgents = (report: AgentsReport | null): string[] => MCP_AGENTS.filter(a => report?.agents.some(r => r.id === a.id && r.installed) === true).map(a => a.id);

/** The file an add for this agent lands in: the one the report already read servers from, else the first the agent
 * reads; a project's own file under that project's folder. */
function fileOf(agent: string, project: AgentsProject | undefined, report: AgentsReport | null): string | undefined {
  const entry = MCP_AGENTS.find(a => a.id === agent);
  if (entry === undefined) return undefined;
  if (project !== undefined) {
    const own = report?.servers.find(r => r.agent === agent && inProject(r, project))?.file;
    const first = entry.mcp.projectFiles?.[0];
    return own ?? (first === undefined ? undefined : `${project.path}/${first}`);
  }
  return report?.servers.find(r => r.agent === agent && r.scope === "user")?.file ?? entry.mcp.files[0];
}

/** What an add has typed so far, the file it lands in, and the one submit that hands it to the host: shared by every
 * place the form is drawn. `agents` is empty, or `servers` absent, where nothing there takes a server. */
function useServerAdd({ report, ctx, done }: AddFormProps) {
  const agents = serverAgents(report);
  const [agent, setAgent] = useState<string>(agents[0] ?? "");
  const [name, setName] = useState("");
  const [road, setRoad] = useState<Road>("command");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [pairs, setPairs] = useState<readonly Pair[]>([]);
  const [next, setNext] = useState(0);
  const [picked, setPicked] = useState<ProjectPick | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const servers = ctx.servers;
  const on = ctx.on ?? ctx.computer ?? "";

  const named = pairs.filter(p => p.name.trim() !== "" || p.value !== "");
  const where = whereNow(report, picked, on);
  const project = where.project;
  const ready = where.lost === undefined && agent !== "" && name.trim() !== "" && (road === "command" ? command.trim() !== "" : url.trim() !== "") && named.every(p => p.name.trim() !== "") && !adding;
  const file = where.lost === undefined ? fileOf(agent, project, report) : undefined;

  const submit = (): void => {
    if (!ready || servers === undefined) return;
    const words = road === "command" ? commandWords(command) : [];
    if (words === undefined) return setRefused(unclosedQuoteRefusal);
    if (new Set(named.map(p => p.name.trim())).size < named.length) return setRefused(W.twoPairsOneName(road));
    const values = Object.fromEntries(named.map(p => [p.name.trim(), p.value]));
    const [program = "", ...args] = words;
    const ask: ServerAdd = {
      agent,
      name: name.trim(),
      ...(project === undefined ? {} : { project: true }),
      ...(road === "command" ? { command: program, args, ...(named.length > 0 ? { env: values } : {}) } : { url: url.trim(), ...(named.length > 0 ? { headers: values } : {}) }),
    };
    setAdding(true);
    setRefused(undefined);
    servers.add(ask, project).then(done, (e: unknown) => {
      setAdding(false);
      setRefused(errorText(e));
    });
  };

  const pick = (to: Road): void => {
    // Variables and headers are not the same thing, so a switch of road starts them over.
    if (to !== road) setPairs([]);
    setRoad(to);
  };
  const setPair = (id: number, change: Partial<Pair>): void => setPairs(all => all.map(p => (p.id === id ? { ...p, ...change } : p)));
  const addPair = (): void => {
    setPairs(all => [...all, { id: next, name: "", value: "" }]);
    setNext(n => n + 1);
  };
  const dropPair = (id: number): void => setPairs(all => all.filter(x => x.id !== id));
  return { agents, servers, on, agent, setAgent, name, setName, road, pick, command, setCommand, url, setUrl, pairs, setPair, addPair, dropPair, where, setPicked: (v: string) => setPicked(pickOf(report, v)), ready, file, adding, refused, submit };
}

const AgentChoice = ({ id }: { id: string }) => (
  <span className="flex min-w-0 items-center gap-[7px]">
    <HarnessMark harness={id} label={agentName(id)} className="size-[13px] shrink-0" />
    <span className="truncate">{agentName(id)}</span>
  </span>
);

function Field({ k, value, set, placeholder, label, secret = false, onEnter, className }: { k: string; value: string; set: (v: string) => void; placeholder: string; label: string; secret?: boolean; onEnter: () => void; className?: string }) {
  return (
    <Input
      data-k={k}
      nativeInput
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      {...(secret ? { type: "password" } : {})}
      onChange={event => set(event.target.value)}
      onKeyDown={event => (event.key === "Enter" ? (event.preventDefault(), onEnter()) : undefined)}
      className={cn(ROW_FIELD, className)}
    />
  );
}

export function AddServerRows({ report, ctx, done }: AddFormProps) {
  const f = useServerAdd({ report, ctx, done });
  if (f.agents.length === 0 || f.servers === undefined) {
    return (
      <Card id="add-server">
        <Line id="add-server-none" label={W.noServerAgents(f.on)} empty />
      </Card>
    );
  }
  const command = f.road === "command";
  const pairWord = command ? W.variables : W.headers;
  return (
    <>
      <Card id="add-server">
        <Row
          id="add-server-agent"
          title={W.agent}
          description=""
          control={
            <Select value={f.agent} onValueChange={v => typeof v === "string" && f.setAgent(v)}>
              <SelectTrigger size="sm" aria-label={W.agent} data-k="add-server-agent" className={SELECT_WIDTH}>
                <SelectValue>{(value: string) => <AgentChoice id={value} />}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {f.agents.map(id => (
                  <SelectItem key={id} value={id} data-k={`add-server-agent-${id}`}>
                    <AgentChoice id={id} />
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <Row id="add-server-name" title={W.serverName} description="" control={<Field k="add-server-name" value={f.name} set={f.setName} placeholder="notion" label={W.serverName} onEnter={f.submit} className="w-44 max-sm:w-full" />} />
        <Row
          id="add-server-road"
          title={W.reachedBy}
          description=""
          control={
            <SegmentedControl
              aria-label={W.reachedBy}
              data-k="add-server-road"
              value={f.road}
              onChange={f.pick}
              segments={[
                { value: "command", label: W.byCommand },
                { value: "address", label: W.byAddress },
              ]}
            />
          }
        />
        {command ? (
          <Row id="add-server-reach" title={W.command} description="" control={<Field k="add-server-command" value={f.command} set={f.setCommand} placeholder="npx -y @notionhq/notion-mcp-server" label={W.command} onEnter={f.submit} className="w-80 max-sm:w-full" />} />
        ) : (
          <Row id="add-server-reach" title={W.url} description="" control={<Field k="add-server-url" value={f.url} set={f.setUrl} placeholder="https://mcp.notion.com/mcp" label={W.url} onEnter={f.submit} className="w-80 max-sm:w-full" />} />
        )}
        {f.where.options.length === 0 ? null : (
          <Row
            id="add-server-where"
            title={W.where}
            description={f.where.lost ?? ""}
            control={
              <Select value={f.where.value} onValueChange={v => typeof v === "string" && f.setPicked(v)}>
                <SelectTrigger size="sm" aria-label={W.where} data-k="where-pick" className={SELECT_WIDTH}>
                  <SelectValue>{(value: string) => f.where.options.find(o => o.value === value)?.label ?? ""}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {f.where.options.map(o => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        )}
      </Card>
      <Card
        id="add-server-pairs"
        head={pairWord}
        under={
          <AddButton data-k="add-server-pair-add" size="xs" onClick={f.addPair}>
            {command ? W.addVariable : W.addHeader}
          </AddButton>
        }
      >
        {f.pairs.map(p => (
          <div key={p.id} data-server-pair className={cn("flex items-center gap-2 py-3", CARD_INSET, ROW_FLOOR)}>
            <Field k="add-server-pair-name" className="min-w-0 flex-1" value={p.name} set={v => f.setPair(p.id, { name: v })} placeholder={command ? "API_KEY" : "Authorization"} label={pairWord} onEnter={f.submit} />
            <Field k="add-server-pair-value" className="min-w-0 flex-1" value={p.value} set={v => f.setPair(p.id, { value: v })} placeholder={W.value} label={`${W.value} of ${p.name.trim() === "" ? (command ? "the variable" : "the header") : p.name.trim()}`} secret onEnter={f.submit} />
            <Button data-k="add-server-pair-drop" size="icon-xs" variant="ghost" aria-label={W.removePair(p.name.trim())} onClick={() => f.dropPair(p.id)}>
              <XIcon aria-hidden />
            </Button>
          </div>
        ))}
      </Card>
      <div className="flex flex-col gap-1">
        <div data-add-server-footer className="flex items-center gap-3">
          <span data-k="add-server-file" className={cn(FACT, "min-w-0 truncate")} title={f.file}>
            {f.file}
          </span>
          <AddButton primary data-k="add-server-go" className="ml-auto shrink-0" busy={f.adding} held={!f.ready} {...(f.ready ? { onClick: f.submit } : {})}>
            {f.adding ? W.adding : W.addServerGo}
          </AddButton>
        </div>
        <RefusalSlot k="add-server-refused" {...(f.refused === undefined ? {} : { said: f.refused })} />
      </div>
    </>
  );
}
