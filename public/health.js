(function(){
  var bar=document.getElementById('dotbar');
  var total=40, filled=16;
  for(var i=0;i<total;i++){
    var s=document.createElement('div');
    s.className='dot-seg'+(i<filled?' filled':'');
    bar.appendChild(s);
  }
})();

function toggle(card){
  var isActive=card.classList.contains('today-active');
  card.classList.toggle('today-active',!isActive);
  card.classList.toggle('upcoming',isActive);
}
