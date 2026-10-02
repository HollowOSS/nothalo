import * as THREE from 'three'

/** One draw call and a fixed pool, shared by every active rocket in the match. */
export class RocketSmoke {
  private readonly count = 384
  private readonly positions = new Float32Array(this.count * 3)
  private readonly sizes = new Float32Array(this.count)
  private readonly alphas = new Float32Array(this.count)
  private readonly ages = new Float32Array(this.count).fill(2)
  private readonly geometry = new THREE.BufferGeometry()
  private cursor = 0
  private readonly viewport = new THREE.Vector2()
  readonly object: THREE.Points
  constructor(scene: THREE.Scene) {
    for (const [name, array, width] of [['position',this.positions,3],['smokeSize',this.sizes,1],['smokeAlpha',this.alphas,1]] as const) {
      this.geometry.setAttribute(name,new THREE.BufferAttribute(array,width).setUsage(THREE.DynamicDrawUsage))
    }
    const material = new THREE.ShaderMaterial({
      uniforms:{viewportHeight:{value:1000}}, transparent:true, depthWrite:false,
      vertexShader:`
        attribute float smokeSize;
        attribute float smokeAlpha;
        uniform float viewportHeight;
        varying float opacity;
        void main() {
          vec4 view = modelViewMatrix * vec4(position,1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = clamp(viewportHeight * projectionMatrix[1][1] * smokeSize / max(.05,-view.z),1.0,88.0);
          opacity = smokeAlpha;
        }`,
      fragmentShader:`
        varying float opacity;
        void main() {
          vec2 p=gl_PointCoord-.5;
          float edge=1.0-smoothstep(.08,.5,length(p));
          float cloud=.8+.2*sin(p.x*17.0+sin(p.y*13.0));
          float alpha=opacity*edge*cloud;
          if(alpha<.003)discard;
          gl_FragColor=vec4(vec3(.78,.78,.75),alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    this.object=new THREE.Points(this.geometry,material)
    this.object.name='rocket-smoke-trails';this.object.frustumCulled=false
    this.object.onBeforeRender=renderer=>{renderer.getDrawingBufferSize(this.viewport);material.uniforms.viewportHeight.value=this.viewport.y}
    scene.add(this.object)
  }
  emit(position:THREE.Vector3):void {
    const i=this.cursor++%this.count
    this.positions.set(position.toArray(),i*3);this.ages[i]=0
    this.sizes[i]=.20;this.alphas[i]=.46
  }
  get activeCount():number { let count=0;for(const age of this.ages)if(age<1.15)count++;return count }
  update(dt:number):void {
    for(let i=0;i<this.count;i++){
      const age=this.ages[i]+=dt
      if(age>=1.15){this.alphas[i]=0;continue}
      this.positions[i*3]+=.045*dt;this.positions[i*3+1]+=.13*dt;this.positions[i*3+2]+=.025*dt
      this.sizes[i]=.20+age*.30;this.alphas[i]=.46*Math.pow(1-age/1.15,1.3)
    }
    for(const name of ['position','smokeSize','smokeAlpha'])this.geometry.attributes[name].needsUpdate=true
    this.object.visible=this.activeCount>0
  }
}
