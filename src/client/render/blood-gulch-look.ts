import * as THREE from 'three'
import {makeGroundGrain} from './terrain/textures.ts'

/** The export carries the low-resolution colour atlas, without CE's grass/dirt
 * detail blend. Restore its palette using the atlas's existing regions, before
 * lighting. Keep this local to terrain so bases, weapons and team colours stay intact. */
export function applyBloodGulchSurface(material:THREE.Material):void {
  const surface=material as THREE.MeshStandardMaterial
  if(!surface.isMeshStandardMaterial||surface.userData.gulchPalette)return
  if(material.name==='cap_moss01b'){
    // CE's plant export has opaque black RGB around the leaves. Bake a keyed
    // alpha once so the visible card and its shadow use the very same cutout.
    if(surface.map){
      const source=surface.map, image=source.image as HTMLImageElement
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
      const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0)
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height)
      for(let i=0;i<pixels.data.length;i+=4){
        const value=Math.max(pixels.data[i],pixels.data[i+1],pixels.data[i+2])
        pixels.data[i+3]=Math.min(pixels.data[i+3],Math.max(0,Math.min(255,(value-10)*8)))
      }
      ctx.putImageData(pixels,0,0);surface.map=source.clone();surface.map.image=canvas;surface.map.needsUpdate=true
    }
    surface.transparent=false;surface.alphaTest=.45;surface.depthWrite=true;surface.side=THREE.DoubleSide
    surface.normalMap=null;surface.roughness=1;surface.metalness=0;surface.userData.gulchPalette=true;surface.needsUpdate=true
    return
  }
  const ground=material.name==='blood_ground'
  const cliff=/^(cap_cliff01b|beavercreek_boulder)$/.test(material.name)
  if(!ground&&!cliff)return
  surface.userData.gulchPalette=true
  surface.roughness=1;surface.roughnessMap=null;surface.metalness=0;surface.envMapIntensity=.12
  // The export is double-sided, so the sunlit faces went into the shadow map too and shadowed
  // themselves: acne, which three's per-pixel rotated PCF turned into a screen-door stipple over
  // every steep sunlit cliff. Only faces turned from the sun cast now. The walls still throw their
  // shadows across the floor, because the faces that cast are the ones in their own shade.
  surface.shadowSide=THREE.BackSide
  // No relief derived from the colour either (surface-detail.ts): from a 256 px albedo it read
  // the painted cracks as deep pits, blocky black flecks along every sunlit crest — the same
  // derived-map fault the guns had. The texture and the real geometry carry the rock.
  surface.normalMap=null
  if(ground){
    // The map-wide colour atlas is not a height map: deriving normals from its
    // painted paths makes whole fields look wet and catches blue sky reflections.
    surface.normalMap=null
    const physical=surface as THREE.MeshPhysicalMaterial
    if(physical.isMeshPhysicalMaterial)physical.specularIntensity=.15
  }
  const grain=ground?makeGroundGrain():null
  const previous=surface.onBeforeCompile.bind(surface),key=surface.customProgramCacheKey.bind(surface)
  surface.onBeforeCompile=(shader,renderer)=>{
    previous(shader,renderer)
    if(ground){
      shader.uniforms.gulchGrain={value:grain}
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vGulchWorld;').replace('#include <project_vertex>','#include <project_vertex>\nvGulchWorld=(modelMatrix*vec4(transformed,1.)).xyz;')
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform sampler2D gulchGrain; varying vec3 vGulchWorld;')
    }
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
      vec3 gulchAtlas = diffuseColor.rgb;
      float gulchLuma = dot(gulchAtlas, vec3(.2126, .7152, .0722));
      ${ground?`
      // Dirt is strongly red-dominant; grass is almost neutral olive in the export.
      // Ratios operate in linear light. Preserve soft boundaries and atlas detail.
      float gulchDirt = smoothstep(1.4, 2.1, gulchAtlas.r / max(gulchAtlas.g, .002));
      float gulchValue = pow(max(gulchLuma, .001), .72);
      vec3 gulchGrass = vec3(.36, .52, .14) * gulchValue * 1.7;
      vec3 gulchSand = vec3(.90, .70, .40) * gulchValue * 1.35;
      // Two world-space frequencies remain sharp independently of the 512px atlas.
      float grassDetail=texture2D(gulchGrain,vGulchWorld.xz/2.).r;
      float soilDetail=texture2D(gulchGrain,vGulchWorld.xz/.65).r;
      float closeDetail=mix(grassDetail,soilDetail,gulchDirt);
      diffuseColor.rgb = mix(gulchGrass, gulchSand, gulchDirt) * clamp(.3+closeDetail, .45,1.5);
      diffuseColor.rgb *= 1. + (grassDetail-.7)*(1.-gulchDirt)*1.1;
      `:`
      diffuseColor.rgb = mix(gulchAtlas, vec3(gulchLuma), .15) * vec3(1., 1.04, 1.06);
      `}
    `)
  }
  surface.customProgramCacheKey=()=>key()+':gulch-palette-v4:'+(ground?'ground':'rock')
  surface.needsUpdate=true
}
