// 构建脚本：把 src 打包成 Obsidian 直接加载的 main.js。
//
// Obsidian 以 CommonJS 加载插件，并自行提供 obsidian 与 electron 模块，
// 因此这两者以及全部 Node 内置模块都必须留在包外，不打进产物。
import esbuild from "esbuild";

const banner = `/*
本文件由构建生成，请勿直接修改；源码见 src/。
*/`;

const options = {
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron"],
  logLevel: "info",
  treeShaking: true,
};

if (process.argv[2] === "production") {
  await esbuild.build({ ...options, minify: true, sourcemap: false });
} else {
  const context = await esbuild.context({ ...options, sourcemap: "inline" });
  await context.watch();
}
