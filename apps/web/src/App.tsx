// Dashboard shell. T22/T23 build the screens from the Penpot file "sdlc-code dashboard".
export function App() {
  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        background: "#0B0F14",
        color: "#E6EDF3",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <nav
        style={{
          width: 232,
          background: "#121821",
          padding: 20,
          borderRight: "1px solid #263041",
        }}
      >
        <strong>sdlc-code</strong>
      </nav>
      <main style={{ padding: 32 }}>
        <h1>Runs</h1>
        <p style={{ color: "#8B98A9" }}>
          Turn a product request into a reviewed pull request.
        </p>
      </main>
    </div>
  );
}
