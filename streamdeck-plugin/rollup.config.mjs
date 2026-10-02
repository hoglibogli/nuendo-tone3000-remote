import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "com.sorg.tone3000.sdPlugin";

const plugins = () => [
	typescript(),
	nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
	commonjs(),
];

/** @type {import('rollup').RollupOptions[]} */
export default [
	{
		input: "src/plugin.ts",
		output: {
			file: `${sdPlugin}/bin/plugin.js`,
			format: "cjs", // der Node-Host von Stream Deck lädt CommonJS
			sourcemap: true,
		},
		// Die Module mit nativen Teilen bleiben aus dem Bündel heraus; sie liegen im
		// .sdPlugin-Ordner und werden zur Laufzeit von dort geladen.
		external: ["@julusian/midi", "@julusian/midi/lazy", "@resvg/resvg-js"],
		plugins: plugins(),
	},
	{
		// Audio-Kindprozess des eigenen Stimmgeräts (child_process.fork aus plugin.js).
		input: "src/tuner/worker.ts",
		output: {
			file: `${sdPlugin}/bin/tuner-worker.js`,
			format: "cjs",
			sourcemap: true,
		},
		// audify (RtAudio, nativ) lädt der Worker zur Laufzeit aus dem .sdPlugin-Ordner.
		external: ["audify"],
		plugins: plugins(),
	},
];
