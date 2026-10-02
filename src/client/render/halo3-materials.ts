import * as THREE from 'three'

/** Deterministic authored PBR surfaces. No downloaded game textures. */
export function guardianMaterial(kind:'alloy'|'bark'|'floor'|'weapon',color:number):THREE.MeshStandardMaterial {
  const n=512,canvas=document.createElement('canvas');canvas.width=canvas.height=n
  const ctx=canvas.getContext('2d')!,im=ctx.createImageData(n,n),height=new Float32Array(n*n)
  let seed=19;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296}
  const grid=Array.from({length:64*64},()=>rand())
  const noise=(x:number,y:number,scale:number)=>{x=x/scale;y=y/scale;const a=Math.floor(x),b=Math.floor(y),u=x-a,v=y-b;const at=(i:number,j:number)=>grid[((j+64)%64)*64+(i+64)%64];return THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(a,b),at(a+1,b),u),THREE.MathUtils.lerp(at(a,b+1),at(a+1,b+1),u),v)}
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const i=y*n+x,cloud=noise(x,y,32)*.55+noise(x,y,8)*.3+rand()*.15
    let h=.52+cloud*.26,v=155+cloud*68,moss=0
    if(kind==='bark'){
      const furrow=Math.pow(Math.abs(Math.sin(x*.16+Math.sin(y*.021+x*.009)*2.1+noise(x,y,32)*4)),.4)
      h=furrow*.65+cloud*.25;v=60+furrow*112+cloud*28;moss=Math.max(0,noise(x,y,64)-.48)*95
    }else if(kind==='floor'||kind==='alloy'){
      const seam=(x%256<3||y%128<3),lip=(x%256>=3&&x%256<6||y%128>=3&&y%128<6)
      if(seam){h=.06;v=43}else if(lip){h=.78;v=197}
      // Broad oxidation and fine pitting remain distinct from machined grooves.
      moss=Math.max(0,noise(x,y,64)-.58)*70
      if(kind==='alloy'&&((x>58&&x<62&&y%256>60)||(y%256>60&&y%256<64&&x>60&&x<200))){h=.15;v=70}
    }else {v=160+cloud*73;h=.5+rand()*.12;if(rand()>.996){v=245;h=.58}}
    height[i]=h;im.data[i*4]=v-moss*.65;im.data[i*4+1]=v-moss*.2;im.data[i*4+2]=v-moss;im.data[i*4+3]=255
  }
  ctx.putImageData(im,0,0)
  if(kind==='alloy'){
    // Stepped, nested engravings form a reusable Forerunner trim sheet over the fine wear.
    const paths=[[[26,24],[196,24],[220,48],[220,184],[196,208],[108,208],[82,234],[26,234]],[[281,27],[483,27],[483,83],[456,109],[456,217],[332,217],[306,191],[281,191]],[[25,282],[82,282],[108,308],[198,308],[224,334],[224,485],[25,485]],[[284,282],[371,282],[397,308],[484,308],[484,485],[284,485]]]
    for(const path of paths)for(const inset of [0,7]){
      ctx.beginPath();path.forEach(([x,y],i)=>i?ctx.lineTo(x+inset,y+inset):ctx.moveTo(x+inset,y+inset));ctx.closePath();ctx.strokeStyle=inset?'#7d8784':'#2e3b3c';ctx.lineWidth=inset?2:5;ctx.stroke()
    }
    for(let y=34;y<192;y+=9){ctx.fillStyle='#414d4d';ctx.fillRect(239,y,15,3);ctx.fillStyle='#a1aba7';ctx.fillRect(239,y+3,15,1)}
  }
  const texture=new THREE.CanvasTexture(canvas);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=8
  const bumpCanvas=document.createElement('canvas');bumpCanvas.width=bumpCanvas.height=n
  const bc=bumpCanvas.getContext('2d')!,bi=bc.createImageData(n,n)
  const roughCanvas=document.createElement('canvas');roughCanvas.width=roughCanvas.height=n
  const rc=roughCanvas.getContext('2d')!,ri=rc.createImageData(n,n)
  for(let i=0;i<n*n;i++){const h=height[i]*255;bi.data.set([h,h,h,255],i*4);const r=kind==='weapon'?150+height[i]*65:190+height[i]*60;ri.data.set([r,r,r,255],i*4)}
  bc.putImageData(bi,0,0);rc.putImageData(ri,0,0)
  const bump=new THREE.CanvasTexture(bumpCanvas),rough=new THREE.CanvasTexture(roughCanvas)
  for(const t of [bump,rough]){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8}
  return new THREE.MeshStandardMaterial({color,map:texture,bumpMap:bump,bumpScale:kind==='bark'?.30:kind==='weapon'?.0015:.065,roughnessMap:rough,roughness:kind==='weapon'?.64:.95,metalness:kind==='bark'?0:kind==='weapon'?.65:.32})
}

/** Metre-based UVs keep panels the same size on small trims and massive columns. */
export function architecturalUV(g:THREE.BufferGeometry,scale=4):THREE.BufferGeometry {
  const p=g.getAttribute('position'),n=g.getAttribute('normal'),uv=new Float32Array(p.count*2)
  for(let i=0;i<p.count;i++){
    const ax=Math.abs(n.getX(i)),ay=Math.abs(n.getY(i)),az=Math.abs(n.getZ(i))
    uv[i*2]=(ax>ay&&ax>az?p.getZ(i):p.getX(i))/scale
    uv[i*2+1]=(ay>ax&&ay>az?p.getZ(i):p.getY(i))/scale
  }
  g.setAttribute('uv',new THREE.BufferAttribute(uv,2));return g
}

const scannedTextures=new Map<string,THREE.Texture>()
/** CC0 scans from Poly Haven; shipped locally, no runtime third-party requests. */
export function scannedSurface(material:THREE.MeshStandardMaterial,asset:string,strength=1):void {
  const get=(kind:string)=>{
    const key=`${asset}_${kind}`,cached=scannedTextures.get(key);if(cached)return cached
    const t=new THREE.TextureLoader().load(`/assets/guardian/${key}.jpg`)
    t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8
    if(kind==='diff')t.colorSpace=THREE.SRGBColorSpace
    scannedTextures.set(key,t);return t
  }
  material.map=get('diff');material.normalMap=get('nor_gl');material.normalScale.setScalar(strength)
  material.roughnessMap=get('rough');material.needsUpdate=true
}
