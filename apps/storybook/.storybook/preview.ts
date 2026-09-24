import type { Preview } from "@storybook/html-vite";
import { themes } from "storybook/theming";
import { disposeStage } from "../src/stage";
import "./preview.css";

const preview: Preview = {
  initialGlobals: { hud: "on" },
  globalTypes: {
    hud: {
      description: "Debug overlay",
      toolbar: {
        title: "Debug",
        icon: "speed",
        items: [
          { value: "on", title: "Debug on" },
          { value: "off", title: "Debug off" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true, sort: "none" },
    docs: { theme: themes.dark },
    options: {
      storySort: {
        order: [
          "Welcome",
          "Showcase",
          ["Small graph", "Galaxy", "Black hole"],
          "Large graph",
          "Nodes",
          ["Shapes"],
          "Edges",
          ["Styles"],
          "Stress",
          ["Scale"],
          "Developer",
          ["Sandbox", "Benchmark", "GPU correctness", "Label correctness", "Label flicker"],
        ],
      },
    },
  },
  // Release the engine (worker + GPU device) when the story is torn down.
  // Storybook calls this once on teardown, not on arg changes.
  beforeEach: () => disposeStage,
};

export default preview;
