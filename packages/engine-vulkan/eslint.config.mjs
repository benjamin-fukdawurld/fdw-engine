import baseConfig from '../../eslint.config.mjs';

// build/: the CMake build.
export default [{ ignores: ['build/**'] }, ...baseConfig];
