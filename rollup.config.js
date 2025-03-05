import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import alias from '@rollup/plugin-alias';

export default {
    input: 'src/app.ts', // Punto de entrada
    output: {
        file: 'dist/app.js', // Archivo de salida
        format: 'esm', // Formato de módulo (ES Modules)
    },
    onwarn: (warning) => {
        if (warning.code === 'UNRESOLVED_IMPORT') return; // Ignorar advertencias de importaciones no resueltas
    },
    plugins: [
        alias({
            entries: [
                { find: '~', replacement: './src' } // Mapear el alias ~ a ./src
            ]
        }),
        typescript(), // Compila TypeScript
        resolve(), // Resuelve módulos de Node.js
        commonjs(), // Convierte módulos CommonJS a ES6
    ],
};