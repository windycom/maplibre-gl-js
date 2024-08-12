import {DepthMode} from '../gl/depth_mode';
import {StencilMode} from '../gl/stencil_mode';

import type {Painter} from './painter';
import type {SourceCache} from '../source/source_cache';
import type {CustomStyleLayer} from '../style/style_layer/custom_style_layer';
import {OverscaledTileID} from '../source/tile_id';
import {CustomLayerArgs} from '../geo/transform_helper';

export function drawCustom(painter: Painter, sourceCache: SourceCache, layer: CustomStyleLayer) {

    const context = painter.context;
    const implementation = layer.implementation;
    const projection = painter.style.projection;
    const transform = painter.transform;

    const projectionData = transform.getProjectionData(new OverscaledTileID(0, 0, 0, 0, 0));

    const customLayerArgs: CustomLayerArgs = {
        farZ: transform.farZ,
        nearZ: transform.nearZ,
        fov: transform.fov * Math.PI / 180, // fov converted to radians
        modelViewProjectionMatrix: transform.modelViewProjectionMatrix,
        projectionMatrix: transform.projectionMatrix,
        shader: {
            variantName: projection.shaderVariantName,
            vertexShaderPrelude: `const float PI = 3.141592653589793;\nuniform mat4 u_projection_matrix;\n${projection.shaderPreludeCode.vertexSource}`,
            define: projection.shaderDefine,
        },
        // Convert all uniforms to plain arrays
        uniforms: {
            'u_projection_matrix': [...projectionData.u_projection_matrix.values()],
            // This next uniform is used to convert from [0..EXTENT] to [0..1] mercator coordinates for a given tile,
            // but since custom layers are expected to already supply mercator coordinates, it is set to identity (offset 0,0 and scale 1,1).
            'u_projection_tile_mercator_coords': [0, 0, 1, 1],
            'u_projection_clipping_plane': [...projectionData.u_projection_clipping_plane.values()],
            'u_projection_transition': projectionData.u_projection_transition,
            'u_projection_fallback_matrix': [...projectionData.u_projection_fallback_matrix.values()], // should be filled in by transform or by custom layer
        },
        // The following should be filled in by the transform.
        getSubdivisionForZoomLevel: null,
        getMatrixForModel: null,
        getMercatorTileProjectionMatrix: null,
    };

    transform.fillCustomLayerArgs(customLayerArgs);
    const customLayerMatrix = transform.customLayerMatrix();

    if (painter.renderPass === 'offscreen') {

        const prerender = implementation.prerender;
        if (prerender) {
            painter.setCustomLayerDefaults();
            context.setColorMode(painter.colorModeForRenderPass());

            prerender.call(implementation, context.gl, customLayerMatrix, customLayerArgs);

            context.setDirty();
            painter.setBaseState();
        }

    } else if (painter.renderPass === 'translucent') {

        painter.setCustomLayerDefaults();

        context.setColorMode(painter.colorModeForRenderPass());
        context.setStencilMode(StencilMode.disabled);

        const depthMode = implementation.renderingMode === '3d' ?
            new DepthMode(painter.context.gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D) :
            painter.depthModeForSublayer(0, DepthMode.ReadOnly);

        context.setDepthMode(depthMode);

        implementation.render(context.gl, customLayerMatrix, customLayerArgs);

        context.setDirty();
        painter.setBaseState();
        context.bindFramebuffer.set(null);
    }
}
