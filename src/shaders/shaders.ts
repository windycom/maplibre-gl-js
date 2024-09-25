
// Disable Flow annotations here because Flow doesn't support importing GLSL files

import preludeFrag from './_prelude.fragment.glsl.g';
import preludeVert from './_prelude.vertex.glsl.g';
import backgroundFrag from './background.fragment.glsl.g';
import backgroundVert from './background.vertex.glsl.g';
import clippingMaskFrag from './clipping_mask.fragment.glsl.g';
import clippingMaskVert from './clipping_mask.vertex.glsl.g';
import debugFrag from './debug.fragment.glsl.g';
import debugVert from './debug.vertex.glsl.g';
import rasterFrag from './raster.fragment.glsl.g';
import rasterVert from './raster.vertex.glsl.g';
import projectionErrorMeasurementVert from './projection_error_measurement.vertex.glsl.g';
import projectionErrorMeasurementFrag from './projection_error_measurement.fragment.glsl.g';
import projectionMercatorVert from './_projection_mercator.vertex.glsl.g';
import projectionGlobeVert from './_projection_globe.vertex.glsl.g';
import atmosphereFrag from './atmosphere.fragment.glsl.g';
import atmosphereVert from './atmosphere.vertex.glsl.g';
import skyFrag from './sky.fragment.glsl.g';
import skyVert from './sky.vertex.glsl.g';

export type PreparedShader = {
    fragmentSource: string;
    vertexSource: string;
    staticAttributes: Array<string>;
    staticUniforms: Array<string>;
};

export const shaders = {
    prelude: compile(preludeFrag, preludeVert),
    projectionMercator: compile('', projectionMercatorVert),
    projectionGlobe: compile('', projectionGlobeVert),
    background: compile(backgroundFrag, backgroundVert),
    clippingMask: compile(clippingMaskFrag, clippingMaskVert),
    debug: compile(debugFrag, debugVert),
    raster: compile(rasterFrag, rasterVert),
    projectionErrorMeasurement: compile(projectionErrorMeasurementFrag, projectionErrorMeasurementVert),
    atmosphere: compile(atmosphereFrag, atmosphereVert),
    sky: compile(skyFrag, skyVert)
};

// Expand #pragmas to #ifdefs.

function compile(fragmentSource: string, vertexSource: string): PreparedShader {
    const re = /#pragma mapbox: ([\w]+) ([\w]+) ([\w]+) ([\w]+)/g;

    const staticAttributes = vertexSource.match(/attribute ([\w]+) ([\w]+)/g);
    const fragmentUniforms = fragmentSource.match(/uniform ([\w]+) ([\w]+)([\s]*)([\w]*)/g);
    const vertexUniforms = vertexSource.match(/uniform ([\w]+) ([\w]+)([\s]*)([\w]*)/g);
    const staticUniforms = vertexUniforms ? vertexUniforms.concat(fragmentUniforms) : fragmentUniforms;

    const fragmentPragmas = {};

    fragmentSource = fragmentSource.replace(re, (match, operation, precision, type, name) => {
        fragmentPragmas[name] = true;
        if (operation === 'define') {
            return `
#ifndef HAS_UNIFORM_u_${name}
varying ${precision} ${type} ${name};
#else
uniform ${precision} ${type} u_${name};
#endif
`;
        } else /* if (operation === 'initialize') */ {
            return `
#ifdef HAS_UNIFORM_u_${name}
    ${precision} ${type} ${name} = u_${name};
#endif
`;
        }
    });

    vertexSource = vertexSource.replace(re, (match, operation, precision, type, name) => {
        const attrType = type === 'float' ? 'vec2' : 'vec4';
        const unpackType = name.match(/color/) ? 'color' : attrType;

        if (fragmentPragmas[name]) {
            if (operation === 'define') {
                return `
#ifndef HAS_UNIFORM_u_${name}
uniform lowp float u_${name}_t;
attribute ${precision} ${attrType} a_${name};
varying ${precision} ${type} ${name};
#else
uniform ${precision} ${type} u_${name};
#endif
`;
            } else /* if (operation === 'initialize') */ {
                if (unpackType === 'vec4') {
                    // vec4 attributes are only used for cross-faded properties, and are not packed
                    return `
#ifndef HAS_UNIFORM_u_${name}
    ${name} = a_${name};
#else
    ${precision} ${type} ${name} = u_${name};
#endif
`;
                } else {
                    return `
#ifndef HAS_UNIFORM_u_${name}
    ${name} = unpack_mix_${unpackType}(a_${name}, u_${name}_t);
#else
    ${precision} ${type} ${name} = u_${name};
#endif
`;
                }
            }
        } else {
            if (operation === 'define') {
                return `
#ifndef HAS_UNIFORM_u_${name}
uniform lowp float u_${name}_t;
attribute ${precision} ${attrType} a_${name};
#else
uniform ${precision} ${type} u_${name};
#endif
`;
            } else /* if (operation === 'initialize') */ {
                if (unpackType === 'vec4') {
                    // vec4 attributes are only used for cross-faded properties, and are not packed
                    return `
#ifndef HAS_UNIFORM_u_${name}
    ${precision} ${type} ${name} = a_${name};
#else
    ${precision} ${type} ${name} = u_${name};
#endif
`;
                } else /* */ {
                    return `
#ifndef HAS_UNIFORM_u_${name}
    ${precision} ${type} ${name} = unpack_mix_${unpackType}(a_${name}, u_${name}_t);
#else
    ${precision} ${type} ${name} = u_${name};
#endif
`;
                }
            }
        }
    });

    return {fragmentSource, vertexSource, staticAttributes, staticUniforms};
}
