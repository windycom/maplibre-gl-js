const float PI = 3.141592653589793;

in vec4 a_pos_offset;
in vec4 a_data;
in vec4 a_pixeloffset;
in vec3 a_projected_pos;
in float a_fade_opacity;

// contents of a_size vary based on the type of property value
// used for {text,icon}-size.
// For constants, a_size is disabled.
// For source functions, we bind only one value per vertex: the value of {text,icon}-size evaluated for the current feature.
// For composite functions:
// [ text-size(lowerZoomStop, feature),
//   text-size(upperZoomStop, feature) ]
uniform bool u_is_size_zoom_constant;
uniform bool u_is_size_feature_constant;
uniform highp float u_size_t; // used to interpolate between zoom stops when size is a composite function
uniform highp float u_size; // used when size is both zoom and feature constant
uniform mat4 u_matrix;
uniform mat4 u_label_plane_matrix;
uniform mat4 u_coord_matrix;
uniform bool u_is_text;
uniform bool u_pitch_with_map;
uniform bool u_is_viewport_line;
uniform highp float u_pitch;
uniform bool u_rotate_symbol;
uniform highp float u_aspect_ratio;
uniform highp float u_camera_to_center_distance;
uniform float u_fade_change;
uniform vec2 u_texsize;
uniform vec2 u_translation;

out vec2 v_data0;
out vec3 v_data1;

#pragma mapbox: define highp vec4 fill_color
#pragma mapbox: define highp vec4 halo_color
#pragma mapbox: define lowp float opacity
#pragma mapbox: define lowp float halo_width
#pragma mapbox: define lowp float halo_blur

// Summary of all transformations that happen here:
// There are three matrices here:
// - u_matrix:
//     - tile.coord.posMatrix, translated by "translate" property
//         - anchor translation rotated by -angle if translateAnchor == viewport
// - u_label_plane_matrix:
//     - identity if symbols along line
//     - if pitchWithMap
//         - scales from tile units to pixels
//         - if not rotateWithMap, rotated by angle
//     - else
//         - tile.coord.posMatrix and scaling from -1..1 to pixels
// - u_coord_matrix:
//     - if pitchWithMap
//         - tile.coord.posMatrix scaled from pixels to tile units
//         - if not rotateWithMap, rotated by -angle
//     - else
//         - matrix from pixels to -1..1
//     - all that with translateanchor applied
//         - anchor translation rotated by angle if translateAnchor==map
// Matrices are used in the following way:
// projectedPoint = u_matrix * a_pos   <------ only used for helper calculations (rotation angle, distance from camera)
// gl_Position = u_coord_matrix * (u_label_plane_matrix * a_projected_pos);
//
// Note that when symbols follow a line, u_label_plane_matrix is identity and a_projected_pos is pre-transformed
// Note that tile.coord.posMatrix contains the main projection matrix
//
// This gives us two main "transform" paths:
//
// pitchWithMap == true:
// - u_label_plane_matrix:
//     - scales from tile units to pixels
//     - if not rotateWithMap, rotated by angle
// - u_coord_matrix:
//     - tile.coord.posMatrix scaled from pixels to tile units
//     - if not rotateWithMap, rotated by -angle
//     - all that with translateanchor applied
//         - anchor translation rotated by angle if translateAnchor==map
//
// pitchWithMap == false:
// - u_label_plane_matrix:
//     - tile.coord.posMatrix and scaling from -1..1 to pixels
// - u_coord_matrix:
//     - matrix from pixels to -1..1
//     - all that with translateanchor applied
//         - anchor translation rotated by angle if translateAnchor==map

// Transforms for different symbol coordinate spaces:
// Note: symbol-translate and symbol-translate-anchor omitted, as it will happen separately
//
//     - map pixel space           pitch-alignment=map         rotation-alignment=map
//         - u_label_plane_matrix:
//             - scales from tile units to pixels
//         - u_coord_matrix:
//             - tile.coord.posMatrix scaled from pixels to tile units
//
//     - rotated map pixel space   pitch-alignment=map         rotation-alignment=viewport
//         - u_label_plane_matrix:
//             - scales from tile units to pixels
//             - rotated by angle
//         - u_coord_matrix:
//             - tile.coord.posMatrix scaled from pixels to tile units
//             - rotated by -angle
//
//     - viewport pixel space      pitch-alignment=viewport    rotation-alignment=*
//         - u_label_plane_matrix:
//             - tile.coord.posMatrix and scaling from -1..1 to pixels
//         - u_coord_matrix:
//             - matrix from pixels to -1..1

// Plan of action to convert symbols for globe:
//
// - unify all coordinate spaces that vertices may be in after u_label_plane_matrix / before u_coord_matrix into a single coordinate space
//     - unified coordinate space = "real 3D space"
//     - when globe is enabled, the map is a unit sphere in this space
//     - when flat rendering is used, the map is the XY plane
//     - TODO: what about scale? flat map must work well with all zooms, without loss of precision
// - calculate proper tangent and bitangent vectors according to desired glyph placement:
//     - map pixel space           pitch-alignment=map         rotation-alignment=map
//         - planet north + east, scaling TODO
//     - rotated map pixel space   pitch-alignment=map         rotation-alignment=viewport
//         - planet north + east, rotated with transform.angle, scaling TODO
//     - viewport pixel space      pitch-alignment=viewport    rotation-alignment=*
//         - camera plane-aligned up and right vectors, scaling to screenspace pixels
// - then project the resulting vertices using the main transform/projection matrix

// Note: I probably want to keep the semantics of "u_coord_matrix" the same - whatever those are (translate by pixels, correct rotation, projection)


void main() {
    #pragma mapbox: initialize highp vec4 fill_color
    #pragma mapbox: initialize highp vec4 halo_color
    #pragma mapbox: initialize lowp float opacity
    #pragma mapbox: initialize lowp float halo_width
    #pragma mapbox: initialize lowp float halo_blur

    vec2 a_pos = a_pos_offset.xy;
    vec2 a_offset = a_pos_offset.zw;

    vec2 a_tex = a_data.xy;
    vec2 a_size = a_data.zw;

    float a_size_min = floor(a_size[0] * 0.5);
    vec2 a_pxoffset = a_pixeloffset.xy;

    float ele = get_elevation(a_pos);
    highp float segment_angle = -a_projected_pos[2];
    float size;

    if (!u_is_size_zoom_constant && !u_is_size_feature_constant) {
        size = mix(a_size_min, a_size[1], u_size_t) / 128.0;
    } else if (u_is_size_zoom_constant && !u_is_size_feature_constant) {
        size = a_size_min / 128.0;
    } else {
        size = u_size;
    }

    vec4 projectedPoint = projectTileWithElevation(vec3(a_pos + u_translation, ele));
    highp float camera_to_anchor_distance = projectedPoint.w;
    // If the label is pitched with the map, layout is done in pitched space,
    // which makes labels in the distance smaller relative to viewport space.
    // We counteract part of that effect by multiplying by the perspective ratio.
    // If the label isn't pitched with the map, we do layout in viewport space,
    // which makes labels in the distance larger relative to the features around
    // them. We counteract part of that effect by dividing by the perspective ratio.
    highp float distance_ratio = u_pitch_with_map ?
        camera_to_anchor_distance / u_camera_to_center_distance :
        u_camera_to_center_distance / camera_to_anchor_distance;
    highp float perspective_ratio = clamp(
        0.5 + 0.5 * distance_ratio,
        0.0, // Prevents oversized near-field symbols in pitched/overzoomed tiles
        4.0);

    size *= perspective_ratio;

    float fontScale = u_is_text ? size / 24.0 : size;

    highp float symbol_rotation = 0.0;
    if (u_rotate_symbol) {
        // Point labels with 'rotation-alignment: map' are horizontal with respect to tile units
        // To figure out that angle in projected space, we draw a short horizontal line in tile
        // space, project it, and measure its angle in projected space.
        vec4 offsetProjectedPoint = projectTileWithElevation(vec3(a_pos + u_translation + vec2(1, 0), ele));

        vec2 a = projectedPoint.xy / projectedPoint.w;
        vec2 b = offsetProjectedPoint.xy / offsetProjectedPoint.w;

        symbol_rotation = atan((b.y - a.y) / u_aspect_ratio, b.x - a.x);
    }

    highp float angle_sin = sin(segment_angle + symbol_rotation);
    highp float angle_cos = cos(segment_angle + symbol_rotation);
    mat2 rotation_matrix = mat2(angle_cos, -1.0 * angle_sin, angle_sin, angle_cos);

    // JP: TODO: asi je dobrý první krok upravit shader?
    vec4 projected_pos;
    if(u_pitch_with_map) {
        projected_pos = u_label_plane_matrix * vec4(a_projected_pos.xy + u_translation, ele, 1.0);
    } else {
        projected_pos = u_label_plane_matrix * projectTileWithElevation(vec3(a_projected_pos.xy + u_translation, ele));
    }

    float z = float(u_pitch_with_map) * projected_pos.z / projected_pos.w;
    vec4 finalPos = u_coord_matrix * vec4(projected_pos.xy / projected_pos.w + rotation_matrix * (a_offset / 32.0 * fontScale + a_pxoffset), z, 1.0);
    if(u_pitch_with_map) {
        finalPos = projectTileWithElevation(finalPos.xyz);
    }
    float gamma_scale = finalPos.w;
    gl_Position = finalPos;

    vec2 fade_opacity = unpack_opacity(a_fade_opacity);
    float visibility = calculate_visibility(projectedPoint);
    float fade_change = fade_opacity[1] > 0.5 ? u_fade_change : -u_fade_change;
    float interpolated_fade_opacity = max(0.0, min(visibility, fade_opacity[0] + fade_change));

    v_data0 = a_tex / u_texsize;
    v_data1 = vec3(gamma_scale, size, interpolated_fade_opacity);
}
