import {
    Uniform1f,
    UniformColor
} from '../uniform_binding';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {Context} from '../../gl/context';
import type {Color} from '@maplibre/maplibre-gl-style-spec';

export type BackgroundUniformsType = {
    'u_opacity': Uniform1f;
    'u_color': UniformColor;
};

const backgroundUniforms = (context: Context, locations: UniformLocations): BackgroundUniformsType => ({
    'u_opacity': new Uniform1f(context, locations.u_opacity),
    'u_color': new UniformColor(context, locations.u_color)
});

const backgroundUniformValues = (opacity: number, color: Color): UniformValues<BackgroundUniformsType> => ({
    'u_opacity': opacity,
    'u_color': color
});

export {
    backgroundUniforms,
    backgroundUniformValues,
};
