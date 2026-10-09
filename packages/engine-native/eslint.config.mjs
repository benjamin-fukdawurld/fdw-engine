import baseConfig from '../../eslint.config.mjs';

// build/: the CMake build, with the sources of the dependencies.
export default [{ ignores: ['build/**'] }, ...baseConfig];
