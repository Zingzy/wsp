// SPDX-License-Identifier: AGPL-3.0-only
import { routeAt } from "./routes";
import { Footer } from "./sections/close";
import { Nav } from "./sections/nav";

export function App({ path = "/" }: { path?: string }) {
  const { Page } = routeAt(path);
  return (
    <>
      <Nav />
      <Page />
      <Footer />
    </>
  );
}
