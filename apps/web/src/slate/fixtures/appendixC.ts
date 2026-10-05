// SPDX-License-Identifier: AGPL-3.0-only
// Appendix C of the spec, "A step-by-step setup the person performs", as the agent writes it, with the two
// corrections the proof of concept applies: the token reaches vercel through its environment and gh through stdin,
// never as an argument. Parsed by the protocol's own parser, so the renderer draws what a write would store.
import { parseSlate, type SlateDoc } from "@wsp/protocol";

export const APPENDIX_C_TEXT = `<slate title="Deploy setup">
  <value name="step" start={1} />
  <value name="repo" start="Zingzy/wsp-landing" />
  <value name="project" start="" />
  <secret name="vercelToken" />
  <run name="check" cmd='vercel project inspect "$PROJECT" 2>&1 | head -c 4000'
    env={{ PROJECT: $project, VERCEL_TOKEN: $vercelToken }} on="host" timeout={30} />
  <run name="env" cmd='grep -v "^VERCEL_TOKEN=" .env > .env.tmp 2>/dev/null; printf "VERCEL_TOKEN=%s\\n" "$VERCEL_TOKEN" >> .env.tmp; mv .env.tmp .env'
    env={{ VERCEL_TOKEN: $vercelToken }} on="host" timeout={10} />
  <run name="ci" cmd='gh secret set VERCEL_TOKEN --repo "$REPO"' stdin={$vercelToken}
    env={{ REPO: $repo }} on="host" timeout={60} />
  <derived name="checked" value={$check.state == 'done' and contains($check.out, $project)} />
  <derived name="written" value={$env.state == 'done' and $ci.state == 'done'} />
  <when change={$project} do={start($check)} />
  <when change={$checked} do={set($step, $checked ? 3 : 2)} />
  <when change={$written} do={set($step, $written ? 4 : 3)} />
  <column>
    <text emphasis="strong">Step {$step} of 4</text>

    <section title="1. The Vercel token" when={$step == 1}>
      <markdown>Open the Vercel dashboard, make a token with the project's scope, and paste it here. It never reaches the agent.</markdown>
      <button label="Open Vercel tokens" onPress={open("https://vercel.com/account/tokens")} />
      <input label="Vercel token" value={$vercelToken} kind="password" />
      <button label="Next" variant="primary" when={$vercelToken.set} onPress={set($step, 2)} />
    </section>

    <section title="2. The project" when={$step == 2 or $step == 3}>
      <input id="project-name" label="Project name on Vercel" value={$project} mono />
      <text when={$check.state == 'held'} tone="muted">Approve the check to go on</text>
      <text when={$check.state == 'running'} tone="muted">Checking</text>
      <text when={$check.state == 'failed'} tone="bad">Vercel did not find it: {short($check.err, 160)}</text>
      <text when={$checked} tone="good">Found {$project}</text>
    </section>

    <section title="3. Write it down" when={$step == 3}>
      <facts>
        <fact label="Repo" value={$repo} mono />
        <fact label="Project" value={$project} mono />
      </facts>
      <row>
        <button label="Write .env" when={$env.state != 'done'} onPress={start($env)} />
        <button label="Set the CI secret" when={$ci.state != 'done'} onPress={start($ci)} />
      </row>
      <text when={$env.state == 'done'} tone="good">.env written</text>
      <text when={$ci.state == 'done'} tone="good">CI secret set</text>
      <text when={$env.state == 'failed' or $ci.state == 'failed'} tone="bad">{short(concat($env.err, $ci.err), 200)}</text>
    </section>

    <section title="4. Done" when={$step == 4}>
      <text tone="good">The token is in .env and in the repo's secrets.</text>
      <button id="write" label="Tell the agent" variant="primary"
        onPress={send("The Vercel setup is done on the slate; wire the deploy hook next.", $repo, $project, $vercelToken)} />
    </section>
  </column>
</slate>
`;

function parsed(): SlateDoc {
  const { document, errors } = parseSlate(APPENDIX_C_TEXT);
  if (document === undefined) throw new Error(`appendix C does not parse: ${errors.map(e => e.message).join("; ")}`);
  return document;
}

export const APPENDIX_C: SlateDoc = parsed();
