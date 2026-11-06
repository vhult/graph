import { NodeShape } from "@vhult/graph";
import { PALETTE } from "@vhult/graph-bench";
import type { ShowcaseIcon } from "./icons";
import { ScenarioBuilder, type Scenario } from "./scenario";

const [BLUE, ORANGE, GREEN, YELLOW, PURPLE, CYAN, PINK, LIME, AMBER, INDIGO] = PALETTE;
const WHITE = 0xf2f4f8;
const GREY = 0x9aa6bd;
const DIM = 0x6b7385;

function company(): Scenario {
  const b = new ScenarioBuilder(
    "Company",
    {
      company: { label: "Company", icon: "building", color: WHITE, shape: NodeShape.hexagon, size: 20, layer: 2 },
      team: { label: "Team", icon: "gear", color: BLUE, shape: NodeShape.square, size: 11, layer: 1 },
      person: { label: "Person", icon: "person", color: BLUE, shape: NodeShape.circle, size: 6 },
    },
    {
      runs: { label: "runs", pattern: "double", directed: true, width: 3.5, color: WHITE },
      has: { label: "has", directed: true, width: 1.5 },
      worksWith: { label: "works with", pattern: "dashed", width: 2, color: GREY },
      pairsWith: { label: "pairs with", pattern: "dotted", width: 2 },
      helps: { label: "helps", pattern: "dashDot", width: 1.5, color: YELLOW, curve: 0.15 },
      mentors: { label: "mentors", tapered: true, width: 3.5 },
    },
  );
  const teams: [string, ShowcaseIcon][] = [
    ["Design", "pen"],
    ["Research", "flask"],
    ["Engineering", "gear"],
    ["Sales", "chart"],
    ["Support", "chat"],
    ["Operations", "bolt"],
  ];
  const people = ["Ada", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "June", "Kai", "Lena", "Milo", "Nina", "Otto"];
  const hub = b.node("Company", "company", 0, 0);
  const heads: number[] = [];
  const members: number[][] = [];
  teams.forEach(([name, icon], g) => {
    const a = (g / teams.length) * Math.PI * 2;
    const hx = Math.cos(a) * 110;
    const hy = Math.sin(a) * 110;
    const color = PALETTE[g]!;
    const head = b.node(name, "team", hx, hy, { color, icon });
    heads.push(head);
    b.link(hub, head, "runs");
    const group: number[] = [];
    for (let m = 0; m < 5; m++) {
      const c = a + (m / 4 - 0.5) * 2.2;
      const person = b.node(`${people[(g * 5 + m) % people.length]} ${String.fromCharCode(65 + g)}.`, "person", hx + Math.cos(c) * 42, hy + Math.sin(c) * 42, { color, size: 5 + (m % 3) });
      group.push(person);
      b.link(head, person, "has");
    }
    b.link(group[0]!, group[1]!, "pairsWith");
    b.link(group[2]!, group[1]!, "mentors");
    b.link(group[2]!, group[3]!, "mentors");
    b.link(group[3]!, group[4]!, "pairsWith");
    members.push(group);
  });
  teams.forEach((_, g) => {
    const next = (g + 1) % teams.length;
    b.link(heads[g]!, heads[next]!, "worksWith");
    b.link(members[g]![4]!, members[next]![0]!, "helps");
  });
  return b.build();
}

function cloud(): Scenario {
  const b = new ScenarioBuilder(
    "Cloud services",
    {
      client: { label: "Client", icon: "person", color: BLUE, shape: NodeShape.circle, size: 10 },
      edge: { label: "Edge", icon: "cloud", color: CYAN, shape: NodeShape.hexagon, size: 13, layer: 1 },
      guard: { label: "Security", icon: "shield", color: PURPLE, shape: NodeShape.square, size: 11, layer: 1 },
      service: { label: "Service", icon: "gear", color: GREEN, shape: NodeShape.circle, size: 10 },
      queue: { label: "Queue", icon: "bolt", color: AMBER, shape: NodeShape.square, size: 9 },
      store: { label: "Database", icon: "database", color: INDIGO, shape: NodeShape.hexagon, size: 11 },
      cache: { label: "Cache", icon: "server", color: PINK, shape: NodeShape.square, size: 9 },
      watch: { label: "Monitoring", icon: "eye", color: YELLOW, shape: NodeShape.circle, size: 10 },
      external: { label: "External", icon: "building", color: GREY, shape: NodeShape.square, size: 10 },
    },
    {
      traffic: { label: "traffic", tapered: true, color: CYAN },
      call: { label: "calls", directed: true, width: 1.5 },
      async: { label: "publishes", pattern: "dashed", directed: true, width: 1.5, color: AMBER, curve: 0.15 },
      replication: { label: "replicates", pattern: "double", width: 3.5, color: INDIGO },
      health: { label: "checks", pattern: "dotted", width: 1.2, color: DIM },
    },
    1.6,
  );
  const row = (i: number) => i * 60;
  const svc = {
    accounts: b.node("Accounts", "service", 0, row(0)),
    search: b.node("Search", "service", 0, row(1)),
    cart: b.node("Cart", "service", 0, row(2)),
    catalog: b.node("Catalog", "service", 0, row(3)),
    reviews: b.node("Reviews", "service", 0, row(4)),
    orders: b.node("Orders", "service", 0, row(5)),
    payments: b.node("Payments", "service", 0, row(6)),
    shipping: b.node("Shipping", "service", 0, row(7)),
    notifications: b.node("Notifications", "service", 0, row(8)),
  };
  const clients = [
    ["Web app", 4, "41k rps"],
    ["iOS app", 3, "22k rps"],
    ["Android app", 3, "19k rps"],
    ["Partner API", 1.5, "3k rps"],
  ] as const;
  const cdn = b.node("CDN", "edge", -400, row(3));
  clients.forEach(([name, width, label], i) => b.link(b.node(name, "client", -530, row(1.5 + i)), cdn, "traffic", label, width));
  const waf = b.node("WAF", "guard", -280, row(3));
  const gateway = b.node("API gateway", "guard", -160, row(3));
  b.link(cdn, waf, "traffic", "85k rps", 5);
  b.link(waf, gateway, "traffic", "85k rps", 5);
  for (const s of [svc.accounts, svc.search, svc.cart, svc.catalog, svc.orders]) b.link(gateway, s, "call");
  const auth = b.node("Auth", "guard", -160, row(5));
  const cache = b.node("Session cache", "cache", -160, row(6.5));
  b.link(gateway, auth, "call");
  b.link(auth, cache, "call");
  b.link(svc.cart, svc.catalog, "call");
  b.link(svc.catalog, svc.reviews, "call");
  b.link(svc.orders, svc.payments, "call");
  const dbs = [
    ["Accounts DB", svc.accounts, 0, true],
    ["Search index", svc.search, 1, false],
    ["Catalog DB", svc.catalog, 3, false],
    ["Orders DB", svc.orders, 5, true],
    ["Payments DB", svc.payments, 6, true],
  ] as const;
  for (const [name, owner, r, replica] of dbs) {
    const db = b.node(name, "store", 200, row(r));
    b.link(owner, db, "call");
    if (replica) b.link(db, b.node(name.replace("DB", "replica"), "store", 340, row(r), { size: 9 }), "replication");
  }
  const orderEvents = b.node("Order events", "queue", -90, row(6.6));
  b.link(svc.orders, orderEvents, "async");
  b.link(orderEvents, svc.shipping, "async");
  b.link(orderEvents, svc.notifications, "async");
  b.link(svc.payments, b.node("Card network", "external", 200, row(7.2)), "call");
  const emailJobs = b.node("Email jobs", "queue", 150, row(8));
  b.link(svc.notifications, emailJobs, "async");
  b.link(emailJobs, b.node("Email provider", "external", 290, row(8)), "async");
  const metrics = b.node("Metrics", "watch", -280, row(0.5));
  for (const t of [cdn, waf, gateway]) b.link(metrics, t, "health");
  return b.build();
}

function investigation(): Scenario {
  const b = new ScenarioBuilder(
    "Investigation",
    {
      case: { label: "Case", icon: "target", color: YELLOW, shape: NodeShape.hexagon, size: 16, layer: 2 },
      person: { label: "Person", icon: "person", color: BLUE, shape: NodeShape.circle, size: 9 },
      company: { label: "Company", icon: "building", color: ORANGE, shape: NodeShape.square, size: 12, layer: 1 },
      account: { label: "Account", icon: "key", color: GREEN, shape: NodeShape.hexagon, size: 9 },
      place: { label: "Place", icon: "pin", color: PINK, shape: NodeShape.circle, size: 9 },
      phone: { label: "Phone", icon: "chat", color: CYAN, shape: NodeShape.circle, size: 7 },
    },
    {
      confirmed: { label: "confirmed", width: 1.5 },
      owns: { label: "owns", directed: true, width: 2 },
      suspected: { label: "suspected", pattern: "dashed", width: 1.5, color: ORANGE },
      inferred: { label: "inferred", pattern: "dotted", width: 1.5, color: GREY, curve: 0.2 },
      family: { label: "family", pattern: "double", width: 3.5, color: PURPLE },
      money: { label: "money", tapered: true, color: GREEN },
    },
    1.6,
  );
  const acct = {
    off55: b.node("Offshore •• 55", "account", 0, -50),
    a4411: b.node("Acct •• 4411", "account", -90, 10),
    a9020: b.node("Acct •• 9020", "account", 90, 10),
    a1337: b.node("Acct •• 1337", "account", 55, 120),
    a7702: b.node("Acct •• 7702", "account", -55, 120),
    a3108: b.node("Acct •• 3108", "account", 200, 150),
  };
  b.link(acct.a4411, acct.off55, "money", "€2.4M", 5);
  b.link(acct.off55, acct.a9020, "money", "€1.9M", 4);
  b.link(acct.a9020, acct.a1337, "money", "€800k", 2.5);
  b.link(acct.a1337, acct.a7702, "money", "€300k", 1.5);
  b.link(acct.a7702, acct.a4411, "money", "€120k", 1);
  b.link(acct.a3108, acct.a9020, "money", "€450k", 2);
  const northwind = b.node("Northwind Trading", "company", -230, 10);
  const victor = b.node("Victor Hale", "person", -230, -110);
  const mira = b.node("Mira Hale", "person", -350, -110);
  b.link(victor, northwind, "owns");
  b.link(northwind, acct.a4411, "owns");
  b.link(victor, mira, "family", "married");
  b.link(northwind, b.node("Rotterdam", "place", -360, 10), "confirmed");
  const lv = b.node("+371 ••• 204", "phone", -290, -210);
  b.link(victor, lv, "inferred");
  b.link(mira, lv, "inferred");
  const baltic = b.node("Baltic Holdings", "company", 230, 10);
  const tomas = b.node("Tomas Reyes", "person", 230, -110);
  b.link(tomas, baltic, "owns");
  b.link(baltic, acct.a9020, "owns");
  b.link(tomas, b.node("Ana Reyes", "person", 350, -110), "family", "siblings");
  b.link(baltic, b.node("Riga", "place", 360, 10), "confirmed");
  b.link(b.node("Ida Berg", "person", 330, -210), tomas, "suspected");
  b.link(baltic, acct.off55, "suspected");
  b.link(acct.off55, b.node("Dubai", "place", 120, -130), "inferred");
  const solace = b.node("Solace Logistics", "company", 0, 250);
  const lena = b.node("Lena Ortiz", "person", 0, 370);
  b.link(lena, solace, "owns");
  b.link(solace, acct.a1337, "owns");
  const eva = b.node("Eva Kim", "person", 140, 330);
  b.link(eva, solace, "confirmed", "works at");
  b.link(eva, acct.a3108, "owns");
  const gdansk = b.node("Gdansk port", "place", -140, 330);
  b.link(solace, gdansk, "confirmed");
  const sami = b.node("Sami Noor", "person", -140, 440);
  b.link(sami, lena, "suspected");
  const burner = b.node("Burner ••• 17", "phone", 0, 480);
  b.link(sami, burner, "inferred");
  b.link(burner, lena, "suspected", "calls");
  const jon = b.node("Jon Park", "person", -200, 150);
  b.link(jon, acct.a7702, "owns");
  b.link(jon, northwind, "suspected");
  b.link(jon, b.node("+31 ••• 881", "phone", -320, 190), "inferred");
  const rui = b.node("Rui Costa", "person", -300, 300);
  b.link(rui, jon, "suspected");
  b.link(rui, gdansk, "inferred");
  const c = b.node("Case 24-117", "case", 0, -250);
  b.link(c, victor, "confirmed", "subject");
  b.link(c, tomas, "confirmed", "subject");
  b.link(c, acct.off55, "confirmed", "flagged");
  return b.build();
}

function supply(): Scenario {
  const b = new ScenarioBuilder(
    "Supply chain",
    {
      farm: { label: "Farm", icon: "leaf", color: LIME, shape: NodeShape.circle, size: 9 },
      plant: { label: "Plant", icon: "factory", color: ORANGE, shape: NodeShape.square, size: 13, layer: 1 },
      port: { label: "Port", icon: "pin", color: CYAN, shape: NodeShape.hexagon, size: 12 },
      hub: { label: "Hub", icon: "truck", color: BLUE, shape: NodeShape.square, size: 12, layer: 1 },
      store: { label: "Store", icon: "store", color: PINK, shape: NodeShape.circle, size: 8 },
    },
    {
      supply: { label: "supplies", tapered: true },
      ships: { label: "ships to", directed: true, width: 1.5 },
      contract: { label: "contract", pattern: "dashed", width: 1.5, color: PURPLE },
      backup: { label: "backup route", pattern: "dashDot", width: 1.5, color: AMBER, curve: 0.15 },
      planned: { label: "planned", pattern: "dotted", width: 1.5, color: GREY },
    },
    1.6,
  );
  const lanes = [-225, -75, 75, 225];
  const farmNames = ["Green Acres", "Hillside", "River Bend", "Oak Valley", "Sunfield", "Maple Row", "Stone Creek", "Willow Farm"];
  const plantNames = ["Mill North", "Dairy Works", "Mill South", "Cannery"];
  const plants = lanes.map((y, i) => b.node(plantNames[i]!, "plant", -160, y));
  const hubs = lanes.map((y, i) => b.node(`Hub ${String.fromCharCode(65 + i)}`, "hub", 40, y));
  const stores = lanes.map((y, i) => [-45, 0, 45].map((dy, k) => b.node(`Store ${i * 3 + k + 1}`, "store", 260, y + dy)));
  lanes.forEach((y, i) => {
    [-35, 35].forEach((dy, k) => {
      const farm = b.node(farmNames[i * 2 + k]!, "farm", -340, y + dy);
      b.link(farm, plants[i]!, "supply", `${20 + (((i * 2 + k) * 7) % 30)} t`, 1.5 + ((i + k) % 3));
      if (k === 1 && i % 2 === 0) b.link(farm, plants[i + 1]!, "backup");
    });
    b.link(plants[i]!, hubs[i]!, "supply", `${120 + i * 40} t`, 4 + (i % 2));
    if (i < lanes.length - 1) b.link(plants[i]!, hubs[i + 1]!, "supply", `${40 + i * 10} t`, 2);
    for (const store of stores[i]!) b.link(hubs[i]!, store, "ships");
    if (i % 2 === 0) b.link(hubs[i]!, stores[i + 1]![0]!, "backup");
  });
  b.link(b.node("Port East", "port", -160, -340), plants[0]!, "contract", "imports");
  b.link(b.node("Port West", "port", -160, 340), plants[3]!, "contract", "imports");
  b.link(hubs[0]!, b.node("Store 13", "store", 260, -330, { color: GREY }), "planned");
  b.link(hubs[3]!, b.node("Store 14", "store", 260, 330, { color: GREY }), "planned");
  return b.build();
}

function grid(): Scenario {
  const b = new ScenarioBuilder(
    "Power grid",
    {
      plant: { label: "Power plant", icon: "bolt", color: AMBER, shape: NodeShape.hexagon, size: 15, layer: 1 },
      wind: { label: "Wind farm", icon: "leaf", color: LIME, shape: NodeShape.hexagon, size: 13, layer: 1 },
      hydro: { label: "Hydro dam", icon: "drop", color: CYAN, shape: NodeShape.hexagon, size: 13, layer: 1 },
      solar: { label: "Solar park", icon: "star", color: YELLOW, shape: NodeShape.hexagon, size: 12, layer: 1 },
      substation: { label: "Substation", icon: "target", color: INDIGO, shape: NodeShape.square, size: 10, layer: 1 },
      city: { label: "City", icon: "building", color: BLUE, shape: NodeShape.circle, size: 14 },
      town: { label: "Town", icon: "house", color: GREY, shape: NodeShape.circle, size: 8 },
      storage: { label: "Battery", icon: "server", color: GREEN, shape: NodeShape.square, size: 9 },
    },
    {
      highVoltage: { label: "high voltage", pattern: "double", width: 4, color: YELLOW },
      feedIn: { label: "feeds in", tapered: true, width: 3.5 },
      line: { label: "local line", width: 1.2 },
      backup: { label: "backup", pattern: "dashed", width: 1.2, color: INDIGO },
      planned: { label: "planned", pattern: "dotted", width: 1.5, color: GREY },
    },
    1.6,
  );
  const n = 10;
  const angle = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const at = (r: number, a: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];
  const stations = Array.from({ length: n }, (_, i) => b.node(`Substation ${i + 1}`, "substation", ...at(160, angle(i))));
  stations.forEach((s, i) => b.link(s, stations[(i + 1) % n]!, "highVoltage", i % 3 === 0 ? "400 kV" : undefined));
  const sources = [
    ["Northgate plant", "plant", 900, 5],
    ["Coastal wind", "wind", 150, 2],
    ["Lake dam", "hydro", 400, 3.5],
    ["Ridge wind", "wind", 150, 2],
    ["Offshore wind", "planned", 0, 0],
    ["Harbor plant", "plant", 900, 5],
    ["Eastfield solar", "solar", 120, 1.5],
    ["Valley dam", "hydro", 400, 3.5],
    ["Plains wind", "wind", 150, 2],
    ["New solar", "planned", 0, 0],
  ] as const;
  sources.forEach(([name, kind, mw, width], i) => {
    const [x, y] = at(350, angle(i));
    if (kind === "planned") {
      b.link(b.node(name, i === 4 ? "wind" : "solar", x, y, { color: GREY }), stations[i]!, "planned", i === 4 ? "2027" : "2026");
      return;
    }
    b.link(b.node(name, kind, x, y), stations[i]!, "feedIn", `${mw} MW`, width);
  });
  const towns: number[][] = stations.map((s, i) =>
    [-0.2, 0.2].map((d, k) => {
      const town = b.node(`Town ${i * 2 + k + 1}`, "town", ...at(250, angle(i) + d));
      b.link(s, town, "line");
      return town;
    }),
  );
  stations.forEach((s, i) => {
    if (i % 2 === 0) b.link(stations[(i + 1) % n]!, towns[i]![1]!, "backup");
  });
  const capital = b.node("Capital", "city", 0, 0, { size: 18 });
  for (const i of [0, 4, 7]) b.link(stations[i]!, capital, "line");
  const portside = b.node("Portside", "city", ...at(85, angle(2)));
  b.link(capital, portside, "highVoltage");
  for (const i of [1, 2, 3]) b.link(stations[i]!, portside, "line");
  const midvale = b.node("Midvale", "city", ...at(85, angle(5.5)), { size: 11 });
  for (const i of [5, 6]) b.link(stations[i]!, midvale, "line");
  b.link(b.node("Battery West", "storage", ...at(105, angle(8.5))), stations[8]!, "line");
  b.link(b.node("Battery East", "storage", ...at(105, angle(3.5))), stations[4]!, "line");
  return b.build();
}

export const SCENARIOS = {
  company: company(),
  cloud: cloud(),
  investigation: investigation(),
  supply: supply(),
  grid: grid(),
} satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;
