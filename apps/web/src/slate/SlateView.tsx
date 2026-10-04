// SPDX-License-Identifier: AGPL-3.0-only
// Draws one slate from its engine: each piece is a host keyed by id that subscribes to its own redraws, reads its
// `when`, resolves its props and hands them to the view its type registers. A piece that throws draws one quiet line
// in its place; a type this build does not know draws its fallback.
import { createContext, memo, useContext, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { SlateJson } from "@wsp/protocol";
import { RenderErrorBoundary } from "../components/RenderErrorBoundary.js";
import { DOC, type SlateEngine } from "./engine.js";
import type { ActionRunner, RaiseOptions, RaiseResult, StateSender } from "./actions.js";
import { truthy } from "./actions.js";
import type { SlateEventName, SlatePiece } from "./model.js";
import { Quiet } from "./pieces/quiet.js";

export interface PieceViewProps {
  id: string;
  piece: SlatePiece;
  /** Every prop resolved, less the ones the view reads in row scope itself. */
  props: Readonly<Record<string, SlateJson | undefined>>;
  /** The child pieces, drawn in order. */
  children: ReactNode;
  slate: SlateEngine;
  raise(event: SlateEventName, options?: RaiseOptions): Promise<RaiseResult>;
  /** Cancels one of the slate's runs; only the output piece and the menu stop a run. */
  cancel(run: string): Promise<unknown>;
  sender: StateSender;
}

export interface PieceView {
  type: string;
  component: ComponentType<PieceViewProps>;
  /** Props evaluated per row by the view, never resolved whole. */
  rowScoped?: readonly string[];
  /** As a row of a section's card, the piece draws its own rows edge to edge rather than taking the row's inset. */
  fills?: boolean | ((slate: SlateEngine, id: string) => boolean);
}

export type PieceViews = Readonly<Record<string, PieceView>>;

interface SlateScope {
  engine: SlateEngine;
  views: PieceViews;
  runner: ActionRunner;
  sender: StateSender;
}

const Scope = createContext<SlateScope | null>(null);

function useScope(): SlateScope {
  const scope = useContext(Scope);
  if (scope === null) throw new Error("a slate piece drawn outside SlateView");
  return scope;
}

export function usePieceVersion(engine: SlateEngine, id: string): number {
  return useSyncExternalStore(
    useMemo(() => (listener: () => void) => engine.subscribe(id, listener), [engine, id]),
    () => engine.pieceVersion(id),
  );
}

export function SlateView({ engine, views, runner, sender }: SlateScope) {
  const scope = useMemo(() => ({ engine, views, runner, sender }), [engine, views, runner, sender]);
  usePieceVersion(engine, DOC);
  const doc = engine.document;
  if (doc === null) return null;
  return (
    <Scope.Provider value={scope}>
      {/* The settings pages' locked look and a 16 px inset, so the cards and lines a slate borrows draw as they do there. */}
      <div data-slate={engine.threadId} data-locked="" className="group/settings flex min-w-0 flex-col [--settings-inset:16px]">
        <PieceHost id={doc.root} />
      </div>
    </Scope.Provider>
  );
}

/** One piece by id. Memoised on the id alone, so a parent's redraw does not redraw its children: each child
 * redraws on its own subscription. */
export const PieceHost = memo(function PieceHost({ id }: { id: string }) {
  const { engine } = useScope();
  usePieceVersion(engine, id);
  // A patch to the piece gives a failed draw another try; a value moving does not remount it.
  return (
    <RenderErrorBoundary key={engine.revision(id)} fallback={<Quiet data-slate-failed={id}>This part could not be drawn</Quiet>}>
      <PieceBody id={id} />
    </RenderErrorBoundary>
  );
});

function PieceBody({ id }: { id: string }) {
  const { engine, views, runner, sender } = useScope();
  const piece = engine.piece(id);
  if (piece === undefined) return null;
  const shown = piece.when === undefined || truthy(engine.evaluate(piece.when));
  engine.setShown(id, shown);
  if (!shown) return null;
  const view = views[piece.type];
  if (view === undefined) return <Fallback piece={piece} />;
  const rowScoped = new Set(view.rowScoped ?? []);
  const props: Record<string, SlateJson | undefined> = {};
  for (const [name, value] of Object.entries(piece.props ?? {})) if (!rowScoped.has(name)) props[name] = engine.resolve(value);
  const Component = view.component;
  const fills = typeof view.fills === "function" ? view.fills(engine, id) : view.fills === true;
  return (
    <div data-slate-piece={id} data-slate-type={piece.type} {...(fills ? { "data-slate-rows": "" } : {})} className="slate-piece min-w-0">
      <Component id={id} piece={piece} props={props} slate={engine} sender={sender} raise={(event, options) => runner.raise(id, event, options)} cancel={run => runner.cancel(run)}>
        {(piece.children ?? []).map(child => (
          <PieceHost key={child} id={child} />
        ))}
      </Component>
    </div>
  );
}

/** What a type this build does not know draws: its fallback piece, nothing, its sentence, or the one quiet line. */
function Fallback({ piece }: { piece: SlatePiece }) {
  const fallback = piece.fallback;
  if (fallback === "drop") return null;
  if (typeof fallback === "string") return <PieceHost id={fallback} />;
  return <Quiet data-slate-unknown={piece.type}>{fallback?.text ?? "This part needs a newer wsp"}</Quiet>;
}
