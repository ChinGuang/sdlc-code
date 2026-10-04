import { screen } from "@testing-library/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { getJson, sendJson } from "../api.js";
import {
  currentPath,
  expectUnstubbed,
  follow,
  press,
  renderApp,
  renderRoute,
  stubApi,
  stubConfirm,
  typeInto,
} from "./screens.js";

/**
 * A worked example of testing screens, for the shapes that are hard to get
 * right: a form that saves and moves on, a screen that reads its route's
 * params, and a list that deletes (after a confirm) and shows itself again.
 * The screens here are small stand-ins; the pattern is what to copy:
 *
 * - answer the API from a table with stubApi, in the Contract's paths; a reply
 *   that is a function answers differently each time or echoes what was sent;
 * - mount the screen on its own route with renderRoute (or the whole App with
 *   renderApp), and look at currentPath() rather than faking useNavigate;
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
    try {
      await sendJson("POST", "/notes", { title });
      navigate("/");
    } catch {
      setError("Could not save the note");
    } finally {
      setSaving(false);
    }
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
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // A late answer for an address the screen has left is ignored.
    let current = true;
    getJson<Note>(`/notes/${id}`)
      .then((loaded) => current && setNote(loaded))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [id]);

  if (failed) return <p>Could not load the note</p>;
  if (!note) return <p>Loading the note…</p>;
  return <h1>{note.title}</h1>;
}

/** A list: each note can be deleted after a confirm, and the list is read again. */
function NotesScreen() {
  const [notes, setNotes] = useState<Note[] | null>(null);

  const load = useCallback(
    () => getJson<Note[]>("/notes").then(setNotes),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (note: Note) => {
    if (!window.confirm(`Delete "${note.title}"?`)) return;
    await sendJson("DELETE", `/notes/${note.id}`);
    await load();
  };

  if (!notes) return <p>Loading the notes…</p>;
  if (notes.length === 0) return <p>No notes yet</p>;
  return (
    <ul>
      {notes.map((note) => (
        <li key={note.id}>
          <Link to={`/notes/${note.id}`}>{note.title}</Link>
          <button type="button" onClick={() => void remove(note)}>
            Delete {note.title}
          </button>
        </li>
      ))}
    </ul>
  );
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

describe("a list that deletes", () => {
  it("asks first, deletes, and shows the list again as the API now has it", async () => {
    const confirm = stubConfirm(true);
    let deleted = false;
    const { calls } = stubApi({
      // Answers differently once the note is gone: the refetch after DELETE.
      "GET /notes": () => ({
        body: deleted ? [] : [{ id: "7", title: "Buy milk" }],
      }),
      "DELETE /notes/7": () => {
        deleted = true;
        return { status: 204 };
      },
    });
    renderRoute(<NotesScreen />);

    const row = (await screen.findByText("Buy milk")).closest("li")!;
    press("Delete Buy milk");

    expect(await screen.findByText("No notes yet")).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith('Delete "Buy milk"?');
    expect(row).not.toBeInTheDocument();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /notes",
      "DELETE /notes/7",
      "GET /notes",
    ]);
  });

  it("deletes nothing when the person says no", async () => {
    stubConfirm(false);
    const { calls } = stubApi({
      "GET /notes": { body: [{ id: "7", title: "Buy milk" }] },
    });
    renderRoute(<NotesScreen />);

    await screen.findByText("Buy milk");
    press("Delete Buy milk");

    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("links each note to its own address", async () => {
    stubApi({ "GET /notes": { body: [{ id: "7", title: "Buy milk" }] } });
    renderRoute(<NotesScreen />);

    await screen.findByText("Buy milk");
    follow("Buy milk");

    expect(currentPath()).toBe("/notes/7");
  });
});

// The whole App, for how its screens fit together.
describe("the App", () => {
  it("opens on the screen of the address, and says so for one that is not", async () => {
    stubApi({
      "GET /health": { body: { status: "ok", database: "up" } },
    });

    renderApp("/");
    expect(await screen.findByText("API ok, database up")).toBeInTheDocument();
  });

  it("answers an address nothing serves", () => {
    renderApp("/nowhere");

    expect(screen.getByText("This page does not exist.")).toBeInTheDocument();
    expect(currentPath()).toBe("/nowhere");
  });
});

describe("stubApi", () => {
  it("fails a request nothing answers, naming what is stubbed", async () => {
    stubApi({ "GET /notes/7": { body: {} } });

    await expect(fetch("/api/notes/8")).rejects.toThrow(
      "No stub for GET /notes/8. Stubbed: GET /notes/7",
    );
    // This test meant it; one that did not would fail when it ends.
    expect(expectUnstubbed()).toEqual([
      "No stub for GET /notes/8. Stubbed: GET /notes/7",
    ]);
  });

  it("reads the path and the body from however fetch was called", async () => {
    const { calls } = stubApi({
      "GET /notes?done=true": { body: [] },
      "PATCH /notes/7": (call) => ({ body: call.body }),
    });

    await fetch("http://localhost/api/notes/?done=true");
    const echoed = await fetch(
      new Request("http://localhost/api/notes/7", {
        method: "PATCH",
        body: JSON.stringify({ title: "Buy oat milk" }),
      }),
    );

    expect(await echoed.json()).toEqual({ title: "Buy oat milk" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /notes?done=true",
      "PATCH /notes/7",
    ]);
  });

  it("leaves no role or text behind that a screen's own queries could find twice", async () => {
    stubApi({ "GET /notes": { body: [] } });
    renderRoute(<NotesScreen />, { route: "/notes", at: "/notes" });

    await screen.findByText("No notes yet");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("/notes")).toBeNull();
    expect(currentPath()).toBe("/notes");
  });
});
