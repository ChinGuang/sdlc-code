/**
 * A design document as it is read, with the text the agents wrote one tab
 * away (T24b; board 03). Whatever cannot be read as its kind is shown raw,
 * and says so.
 */
import { useState } from "react";
import type { DocumentKind } from "../api/types.js";
import { Markdown } from "./Markdown.js";
import {
  parseApiContract,
  parsePenpotDesign,
  parseSlicePlan,
  parseUiSpec,
  raw,
  type ApiContract,
  type Operation,
  type PlannedSlice,
  type SchemaView,
  type UiScreen,
} from "./parse.js";

export function DocumentBody({
  kind,
  content,
  slicePlan = null,
}: {
  kind: DocumentKind;
  content: string;
  /** The Slice Plan's text, for the API Contract's "which Slice" column. */
  slicePlan?: string | null;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const readable = readableView(kind, content, slicePlan);
  return (
    <div className="document-view">
      <div className="segmented view-switch" role="group" aria-label="View">
        <button
          type="button"
          aria-pressed={!showRaw}
          onClick={() => setShowRaw(false)}
        >
          Readable
        </button>
        <button
          type="button"
          aria-pressed={showRaw}
          onClick={() => setShowRaw(true)}
        >
          Raw
        </button>
      </div>
      {showRaw ? (
        <pre className="document-body" aria-label="Raw document">
          {raw(content)}
        </pre>
      ) : readable ? (
        readable
      ) : (
        <>
          <p className="warning small" role="status">
            This document is not in the shape a {kind} has, so it is shown as
            written.
          </p>
          <pre className="document-body">{raw(content)}</pre>
        </>
      )}
    </div>
  );
}

function readableView(
  kind: DocumentKind,
  content: string,
  slicePlan: string | null,
) {
  switch (kind) {
    case "systemDesign":
      return <Markdown source={content} />;
    case "slicePlan": {
      const slices = parseSlicePlan(content);
      return slices && <SlicePlanView slices={slices} />;
    }
    case "apiContract": {
      const contract = parseApiContract(content);
      return (
        contract && (
          <ApiContractView
            contract={contract}
            slices={slicePlan ? (parseSlicePlan(slicePlan) ?? []) : []}
          />
        )
      );
    }
    case "uiSpec": {
      const spec = parseUiSpec(content);
      return spec && <UiSpecView screens={spec.screens} tokens={spec.tokens} />;
    }
    case "penpotDesign": {
      const design = parsePenpotDesign(content);
      return (
        design && (
          <div className="penpot-view">
            <p>
              Page <strong>{design.page || "(unnamed)"}</strong> in the Penpot
              file, with {design.screens.length} screens drawn from the UI Spec:
            </p>
            <ul>
              {design.screens.map((screen) => (
                <li key={screen}>{screen}</li>
              ))}
            </ul>
          </div>
        )
      );
    }
  }
}

function SlicePlanView({ slices }: { slices: PlannedSlice[] }) {
  return (
    <ol className="plan">
      {slices.map((slice, index) => (
        <li key={`${index}-${slice.title}`}>
          <div className="plan-head">
            <span className="mono faint">Slice {index + 1}</span>
            <strong>{slice.title}</strong>
            {slice.isWalkingSkeleton && (
              <span className="chip">walking skeleton</span>
            )}
          </div>
          <p className="muted">{slice.goal}</p>
          {slice.endpoints.length > 0 && (
            <div className="chips">
              {slice.endpoints.map((endpoint) => (
                <span key={endpoint} className="chip mono">
                  {endpoint}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

const METHOD_TONE: Record<string, string> = {
  GET: "text-blue",
  POST: "text-green",
  PUT: "text-amber",
  PATCH: "text-amber",
  DELETE: "text-red",
};

function ApiContractView({
  contract,
  slices,
}: {
  contract: ApiContract;
  slices: PlannedSlice[];
}) {
  const [tab, setTab] = useState<"endpoints" | "schemas">("endpoints");
  const [chosen, setChosen] = useState<string | null>(null);
  const selected =
    contract.operations.find((one) => one.endpoint === chosen) ??
    contract.operations[0] ??
    null;
  const sliceOf = (endpoint: string) => {
    const index = slices.findIndex((slice) =>
      slice.endpoints.includes(endpoint),
    );
    return index === -1 ? "" : `Slice ${index + 1}`;
  };
  return (
    <div className="contract">
      <p className="muted small">
        {[contract.title, contract.version && `v${contract.version}`]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="segmented" role="group" aria-label="Contract">
        <button
          type="button"
          aria-pressed={tab === "endpoints"}
          onClick={() => setTab("endpoints")}
        >
          Endpoints {contract.operations.length}
        </button>
        <button
          type="button"
          aria-pressed={tab === "schemas"}
          onClick={() => setTab("schemas")}
        >
          Schemas {contract.schemas.length}
        </button>
      </div>
      {tab === "endpoints" ? (
        <>
          <table className="endpoints" aria-label="Endpoints">
            <tbody>
              {contract.operations.map((operation) => (
                <tr
                  key={operation.endpoint}
                  className={operation === selected ? "selected" : ""}
                >
                  <td className={`mono ${METHOD_TONE[operation.method] ?? ""}`}>
                    {operation.method}
                  </td>
                  <td className="mono">
                    <button
                      type="button"
                      className="link-button mono"
                      aria-pressed={operation === selected}
                      onClick={() => setChosen(operation.endpoint)}
                    >
                      {operation.path}
                    </button>
                  </td>
                  <td className="muted small">{operation.summary}</td>
                  <td className="faint small">{sliceOf(operation.endpoint)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected && <OperationView operation={selected} />}
        </>
      ) : (
        <div className="schemas">
          {contract.schemas.length === 0 && (
            <p className="muted">No shared schemas.</p>
          )}
          {contract.schemas.map(({ name, schema }) => (
            <section key={name} aria-label={`Schema ${name}`}>
              <h4 className="mono">{name}</h4>
              <Fields schema={schema} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function OperationView({ operation }: { operation: Operation }) {
  return (
    <section
      className="operation"
      aria-label={`${operation.method} ${operation.path}`}
    >
      <h4 className="mono">
        <span className={METHOD_TONE[operation.method] ?? ""}>
          {operation.method}
        </span>{" "}
        {operation.path}
      </h4>
      {operation.summary && <p className="muted">{operation.summary}</p>}
      {operation.parameters.length > 0 && (
        <>
          <h5 className="eyebrow">Parameters</h5>
          <FieldTable fields={operation.parameters} />
        </>
      )}
      {operation.requestBody && (
        <>
          <h5 className="eyebrow">
            Request body · {operation.requestBody.type}
          </h5>
          <Fields schema={operation.requestBody} />
        </>
      )}
      <h5 className="eyebrow">Responses</h5>
      <ul className="responses">
        {operation.responses.map((response) => (
          <li key={response.status}>
            <span
              className={`mono ${response.status.startsWith("2") ? "text-green" : "text-red"}`}
            >
              {response.status}
            </span>{" "}
            {response.description}
            {response.body && (
              <span className="mono faint"> → {response.body.type}</span>
            )}
            {response.body && response.body.fields.length > 0 && (
              <Fields schema={response.body} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Fields({ schema }: { schema: SchemaView }) {
  return schema.fields.length === 0 ? (
    <p className="mono faint small">{schema.type}</p>
  ) : (
    <FieldTable fields={schema.fields} />
  );
}

function FieldTable({ fields }: { fields: SchemaView["fields"] }) {
  return (
    <table className="fields">
      <tbody>
        {fields.map((field) => (
          <tr key={field.name}>
            <td className="mono">
              {field.name}
              {field.required && <span className="text-red"> *</span>}
            </td>
            <td className="mono text-blue">{field.type}</td>
            <td className="faint small">{field.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The board every screen is laid out on (the UI Spec's BOARD_WIDTH/HEIGHT). */
const BOARD = { width: 1280, height: 800 };

function UiSpecView({
  screens,
  tokens,
}: {
  screens: UiScreen[];
  tokens: Array<{ name: string; value: string }>;
}) {
  return (
    <div className="ui-spec">
      {tokens.length > 0 && (
        <div className="tokens" aria-label="Design tokens">
          {tokens.map((token) => (
            <span key={token.name} className="token small">
              {/^#[0-9a-f]{6}$/i.test(token.value) && (
                <span
                  className="swatch"
                  style={{ background: token.value }}
                  aria-hidden="true"
                />
              )}
              {token.name} <span className="mono faint">{token.value}</span>
            </span>
          ))}
        </div>
      )}
      {screens.map((screen) => (
        <section
          key={`${screen.route}-${screen.name}`}
          className="screen"
          aria-label={`Screen ${screen.name}`}
        >
          <div className="screen-text">
            <h4>
              {screen.name} <span className="mono faint">{screen.route}</span>
            </h4>
            <p className="muted">{screen.purpose}</p>
            <p className="small faint">Slice: {screen.sliceTitle}</p>
            {screen.states.length > 0 && (
              <p className="small">States: {screen.states.join(", ")}</p>
            )}
            {screen.endpoints.length > 0 && (
              <div className="chips">
                {screen.endpoints.map((endpoint) => (
                  <span key={endpoint} className="chip mono">
                    {endpoint}
                  </span>
                ))}
              </div>
            )}
          </div>
          {/* The layout, scaled down: a wireframe of what Penpot draws. */}
          <div
            className="wireframe"
            role="img"
            aria-label={`Layout of ${screen.name}: ${screen.elements
              .map((element) => `${element.kind} "${element.label}"`)
              .join(", ")}`}
          >
            {screen.elements.map((element, index) => (
              <span
                key={index}
                className={`element element-${element.kind}`}
                style={{
                  left: `${(element.x / BOARD.width) * 100}%`,
                  top: `${(element.y / BOARD.height) * 100}%`,
                  width: `${(element.width / BOARD.width) * 100}%`,
                  height: `${(element.height / BOARD.height) * 100}%`,
                }}
              >
                {element.label}
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
