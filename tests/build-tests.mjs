import esbuild from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "silent",
};

await esbuild.build({
  ...common,
  entryPoints: ["src/processor.ts"],
  outfile: "tests/.tmp/processor.cjs",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/headingMath.ts"],
  outfile: "tests/.tmp/headingMath.cjs",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/headingSource.ts"],
  outfile: "tests/.tmp/headingSource.cjs",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/embedTargets.ts"],
  outfile: "tests/.tmp/embedTargets.cjs",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/embedData.ts"],
  outfile: "tests/.tmp/embedData.cjs",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/outlineHeadings.ts"],
  outfile: "tests/.tmp/outlineHeadings.cjs",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/outline.ts"],
  outfile: "tests/.tmp/outline.cjs",
});
