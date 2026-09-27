import content from "virtual:content";
import { LandingGraph } from "../landing/LandingGraph";
import { Badges } from "../layout/Integrations";
import { Blocks } from "../render/Blocks";
import { Code, CopyButton } from "../render/Code";
import { Link } from "../router";

export function Landing() {
  const { landing } = content.site;
  return (
    <div className="landing">
      <section className="intro">
        <h1 className="intro-title">{landing.tagline}</h1>
        <p className="intro-lead">{landing.lead}</p>
        <div className="intro-row">
          <div className="install">
            <code>{landing.install}</code>
            <CopyButton text={landing.install} />
          </div>
          <div className="actions">
            {landing.actions.map((a) => (
              <Link key={a.href} href={a.href} className={a.primary ? "button primary" : "button"}>
                {a.label}
              </Link>
            ))}
          </div>
        </div>
        <Badges />
      </section>
      <section className="showcase">
        <div className="showcase-code">
          <Code source={landing.code} title={landing.codeTitle} />
        </div>
        <figure className="showcase-graph">
          <figcaption>
            <span>Live</span>
            <span>drag a node</span>
          </figcaption>
          <LandingGraph />
        </figure>
      </section>
      <section className="landing-body">
        <Blocks blocks={landing.blocks} />
      </section>
    </div>
  );
}
