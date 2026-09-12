// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Agents: one row per agent this computer has, each saying whether
// its own config names the wsp tools. The catalog is the host's, read through
// the same init.get the setup screens read, so there is one reading of which
// agents are here and this section grows a row the day that reading does.
//
// Three states, and the row's right edge is the whole of each: an agent holding
// the tools says so, one that could hold them carries the button that adds them,
// and one whose thread wsp cannot hand them to at launch says that and is
// offered nothing. Adding them has no road from the app yet, so the button is
// drawn held, as this column's other roadless actions are.
import { useEffect, useState } from "react";
import type { InitAgent } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { useStore } from "../protocol/store.js";
import { AGENTS_WORDS, FACT } from "./format.js";
import { Row, Section } from "./rows.js";

export function AgentsSection() {
  const api = useStore(s => s.api);
  const [agents, setAgents] = useState<readonly InitAgent[]>([]);
  useEffect(() => {
    if (api?.initGet === undefined) return;
    let live = true;
    void api.initGet().then(
      setup => {
        if (live) setAgents(setup.agents);
      },
      () => {
        if (live) setAgents([]);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  return (
    <Section id="settings-agents" title={AGENTS_WORDS.title}>
      {agents.length === 0 ? (
        <Row id="settings-agents-none" label={AGENTS_WORDS.none} note />
      ) : (
        agents.map(agent => <AgentRow key={agent.id} agent={agent} />)
      )}
    </Section>
  );
}

function AgentRow({ agent }: { agent: InitAgent }) {
  const state = agent.configured ? AGENTS_WORDS.added : agent.takesTools ? null : AGENTS_WORDS.noTools;
  return (
    <Row
      id={`settings-agent-${agent.id}`}
      label={agent.name}
      {...(state === null
        ? {}
        : {
            fact: (
              <span className={FACT} data-k="agent-state">
                {state}
              </span>
            ),
          })}
    >
      {state === null ? (
        <Button data-k="agent-add" size="xs" held>
          {AGENTS_WORDS.add}
        </Button>
      ) : null}
    </Row>
  );
}
