function toggleBookmark(id) {
  var bm = []; try{ bm=JSON.parse(localStorage.getItem('mvp_bookmarks')||'[]'); }catch(e){}
  var action = "bookmark";
  
  if(bm.includes(id)) { 
    bm = bm.filter(function(x){ return x !== id; }); 
    action = "unbookmark";
  } else { 
    bm.push(id); 
  }
  localStorage.setItem('mvp_bookmarks', JSON.stringify(bm));
  
  // Kirim diam-diam ke server!
  fetch("/api/interact", {
    method: "POST",
    headers: accessHeaders(),
    body: JSON.stringify({ action: action, project_id: id, value: 1 })
  }).catch(function(){});

  if(!$('detail').classList.contains('hidden')) openProject(id); else renderHome();
}
