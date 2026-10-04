import { screen } from "@testing-library/react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { getJson } from "../api.js";
import {
  currentPath,
  press,
  renderRoute,
  stubApi,
  typeInto,
} from "./screens.js";

/**
 * A worked example of testing screens, for the two shapes that are hard to get
 * right: a form that saves and moves on, and a screen that reads its route's
 * params. The screens here are small stand-ins; the pattern is what to copy:
 *
 * - answer the API from a table with stubApi, in the Contract's paths;
 * - mount the screen on its own route with renderRoute, and look at
 *   currentPath() rather than faking useNavigate;
 * - type and press as a person does, then wait for what shows (findBy…).
 */

type Note = { id: string; title: string };

/** A form: type a title, save it, go back to the list. */
function NewNoteScreen() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const response = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      setError("Could not save the note");
      setSaving(false);
      return;
    }
    navigate("/");
  };

  return (
    <form onSubmit={save}>
      <h1>New note</h1>
      <label htmlFor="title">Title</label>
      <input
        id="title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/** A screen that reads :id from its route. */
function NoteScreen() {
  const { id } = useParams<{ id: string }>();
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<Note>(`/notes/${id}`)
      .then(setNote)
      .catch((problem: unknown) =>
        setError(problem instanceof Error ? problem.message : String(problem)),
      );
  }, [id]);

  if (error) return <p>Could not load the note</p>;
  if (!note) return <p>Loading the note…</p>;
  return <h1>{note.title}</h1>;
}

describe("a form screen", () => {
  it("saves what was typed and goes back to the list", async () => {
    const { calls } = stubApi({ "POST /notes": { status: 201, body: {} } });
    renderRoute(<NewNoteScreen />, { route: "/new" });

    typeInto("Title", "Buy milk");
    press("Save");

    // The router moved: that is how a test sees navigate("/").
    await expect.poll(currentPath).toBe("/");
    expect(calls).toEqual([
      { method: "POST", path: "/notes", body: { title: "Buy milk" } },
    ]);
  });

  it("shows it is saving, and cannot be pressed twice", async () => {
    stubApi({ "POST /notes": "pending" });
    renderRoute(<NewNoteScreen />, { route: "/new" });

    typeInto("Title", "Buy milk");
    press("Save");

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("says so when saving fails, and stays where it is", async () => {
    stubApi({ "POST /notes": { status: 500 } });
    renderRoute(<NewNoteScreen />, { route: "/new" });

    typeInto("Title", "Buy milk");
    press("Save");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the note",
    );
    expect(currentPath()).toBe("/new");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("a screen that reads its route's params", () => {
  // Rendered through its route, or useParams() is empty.
  it("loads the note its address names", async () => {
    const { calls } = stubApi({
      "GET /notes/7": { body: { id: "7", title: "Buy milk" } },
    });
    renderRoute(<NoteScreen />, { route: "/notes/:id", at: "/notes/7" });

    expect(screen.getByText("Loading the note…")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Buy milk" }),
    ).toBeInTheDocument();
    expect(calls.map((call) => call.path)).toEqual(["/notes/7"]);
  });

  it("says so when the note cannot be loaded", async () => {
    stubApi({ "GET /notes/7": { status: 404 } });
    renderRoute(<NoteScreen />, { route: "/notes/:id", at: "/notes/7" });

    expect(
      await screen.findByText("Could not load the note"),
    ).toBeInTheDocument();
  });
});

describe("stubApi", () => {
  it("fails a request nothing answers, naming what is stubbed", async () => {
    stubApi({ "GET /notes/7": { body: {} } });

    await expect(fetch("/api/notes/8")).rejects.toThrow(
      "No stub for GET /notes/8. Stubbed: GET /notes/7",
    );
  });
});
