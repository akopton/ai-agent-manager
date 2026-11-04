export default function HomePage() {
  return (
    <>
      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">Your development workspace</p>
        <h1 id="page-title">AI Agent Manager</h1>
        <p className="lead">
          Coordinate coding tasks across local repositories and review agent
          changes before publishing.
        </p>
        <p className="status">Application setup is complete. Task management is coming next.</p>
      </section>
      <section aria-labelledby="planned-areas">
        <h2 id="planned-areas">Coming next</h2>
        <div className="areas">
          <article>
            <h3>Projects</h3>
            <p>A library of your local Git repositories.</p>
          </article>
          <article>
            <h3>Project boards</h3>
            <p>A dedicated place to organize each project’s tasks.</p>
          </article>
          <article>
            <h3>Overview</h3>
            <p>A global dashboard for queued work, active runs, and reviews.</p>
          </article>
        </div>
      </section>
    </>
  );
}
