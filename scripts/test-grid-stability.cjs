const fs=require('fs'),{chromium}=require(require.resolve('playwright', {paths:[process.cwd(),require('os').homedir()]}));
(async()=>{
  const root=require('path').resolve(__dirname,'..')+'/';
 const source=fs.readFileSync(root+'inventory/app.js','utf8');
 const begin=source.indexOf('  function render() {'),end=source.indexOf('  function setDetailReadOnly',begin);
 if(begin<0||end<0)throw Error('RENDER_NOT_FOUND');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 const page=await browser.newPage(); await page.setContent('<div id="grid"></div>');
 const helper=fs.existsSync(root+'inventory/grid-render-core.js')?fs.readFileSync(root+'inventory/grid-render-core.js','utf8'):'';
 if(helper)await page.addScriptTag({content:helper});
 const result=await page.evaluate(renderSource=>{
  const el={inventoryGrid:document.querySelector('#grid'),resultCount:{},loadMoreButton:{},emptyState:{}};
  let records=[{id:'test-a',stock:1},{id:'test-b',stock:2}];
  const state={sortDirection:'none'},clearMissingActiveDetail=()=>{},filteredItems=()=>records,updateSummary=()=>{},handleProductImageError=()=>{};
  const cardMarkup=(item)=>'<article data-id="'+item.id+'"><img class="product-image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><span>'+item.stock+'</span></article>';
  const render=eval('('+renderSource.trim()+')');render();
  const a=el.inventoryGrid.children[0],b=el.inventoryGrid.children[1],img=b.querySelector('img');
  for(let i=0;i<20;i++)render();
  const noOpStable=el.inventoryGrid.children[0]===a && el.inventoryGrid.children[1]===b && b.querySelector('img')===img;
  records=[{id:'test-a',stock:3},{id:'test-b',stock:2}];render();
  const changedVisible=el.inventoryGrid.children[0].textContent==='3',unchangedStable=el.inventoryGrid.children[1]===b;
  records=[records[1]];render();
  const deleteCorrect=el.inventoryGrid.children.length===1&&el.inventoryGrid.children[0].dataset.id==='test-b';
  records=[{id:'test-c',stock:4},records[0]];render();
  const addCorrect=el.inventoryGrid.children.length===2&&el.inventoryGrid.children[0].textContent==='4';
  const beforeReorder=Array.from(el.inventoryGrid.children); records.reverse(); render();
  const reorderCorrect=el.inventoryGrid.children[0]===beforeReorder[1]&&el.inventoryGrid.children[1]===beforeReorder[0];
  return {noOpStable,changedVisible,unchangedStable,deleteCorrect,addCorrect,reorderCorrect};
 },source.slice(begin,end));
 console.log(JSON.stringify(result));if(Object.values(result).some(v=>v!==true))process.exitCode=1;
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});