// SPDX-License-Identifier: MPL-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, HttpRunsApi, type RunsApi } from "../api/client.js";
import { App } from "../App.js";
import { fakeApi } from "../testing/fakeApi.js";
import { SignIn } from "./SignIn.js";

describe("the dashboard of a server that asks for a token", () => {
  it("asks for the token before showing anything of the Runs", async () => {
    const { api } = fakeApi({});
    const listRuns = vi.fn(api.listRuns);
    const gated: RunsApi = {
      ...api,
      listRuns,
      session: async () => ({ required: true, signedIn: false }),
    };

    render(<App api={gated} />);

    expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("goes on to the Runs once the token is accepted", async () => {
    const { api } = fakeApi({});
    const signIn = vi.fn(async () => {});
    const gated: RunsApi = {
      ...api,
      signIn,
      session: async () => ({ required: true, signedIn: false }),
    };
    render(<App api={gated} />);

    fireEvent.change(await screen.findByLabelText("Access token"), {
      target: { value: "tok" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(signIn).toHaveBeenCalledWith("tok");
    expect(await screen.findByLabelText("New run")).toBeInTheDocument();
  });

  it("says what the server said when the token is wrong, and stays put", async () => {
    const { api } = fakeApi({});
    const wrong: RunsApi = {
      ...api,
      signIn: async () => {
        throw new ApiError(401, "That token is not right.");
      },
    };
    render(<SignIn api={wrong} onSignedIn={() => {}} />);

    fireEvent.change(screen.getByLabelText("Access token"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That token is not right.",
    );
  });

  it("shows no sign-in to a local server", async () => {
    const { api } = fakeApi({});

    render(<App api={api} />);

    expect(await screen.findByLabelText("New run")).toBeInTheDocument();
    expect(screen.queryByLabelText("Access token")).toBeNull();
  });
});

describe("HttpRunsApi.session", () => {
  const withFetch = (respond: () => Response | Promise<Response>) =>
    new HttpRunsApi({ fetch: (async () => respond()) as typeof fetch });

  it("asks for the token when the server fails in any way but a missing /session", async () => {
    expect(
      await withFetch(() => new Response("", { status: 500 })).session(),
    ).toEqual({ required: true, signedIn: false });
    expect(
      await withFetch(() => new Response("", { status: 401 })).session(),
    ).toEqual({ required: true, signedIn: false });
  });

  it("asks for it again when a request is turned away", async () => {
    let asked = 0;
    const api = new HttpRunsApi({
      onUnauthorized: () => (asked += 1),
      fetch: (async () =>
        new Response(JSON.stringify({ message: "Sign in" }), {
          status: 401,
        })) as typeof fetch,
    });

    await expect(api.listRuns()).rejects.toMatchObject({ status: 401 });

    expect(asked).toBe(1);
  });

  it("reads what the server says", async () => {
    const api = withFetch(
      () =>
        new Response(JSON.stringify({ required: true, signedIn: false }), {
          status: 200,
        }),
    );
    expect(await api.session()).toEqual({ required: true, signedIn: false });
  });

  it("takes a server with no /session, or none at all, as asking for nothing", async () => {
    expect(
      await withFetch(() => new Response("", { status: 404 })).session(),
    ).toEqual({ required: false, signedIn: true });
    expect(
      await withFetch(() => {
        throw new Error("down");
      }).session(),
    ).toEqual({ required: false, signedIn: true });
  });

  it("signs in with a JSON body, and throws what the server refused with", async () => {
    let sent: RequestInit | undefined;
    const ok = new HttpRunsApi({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent = init;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await ok.signIn("tok");
    expect(JSON.parse(sent!.body as string)).toEqual({ token: "tok" });

    await expect(
      withFetch(
        () =>
          new Response(
            JSON.stringify({ message: "That token is not right." }),
            {
              status: 401,
            },
          ),
      ).signIn("x"),
    ).rejects.toMatchObject({
      status: 401,
      message: "That token is not right.",
    });
  });
});
