<template>
  <div>
    <transition name='toggle'>
      <div class='left' v-if='fade'>
        <ul>
          <li id='logo'>
            <div><img src='../assets/images/menu_logo.png'></img></div>
          </li>
          <li id='lists' v-for='list in linklist'>
            <router-link :to='list.link' >{{ list.content }}</router-link>
          </li>
          <li id='copyright'>
            <div>ProofU Project</div>
            <div>YeungNam Univ</div>
            <div>Computer Engineering</div>
            <div>Copyright ⓒ 2019. All Rights Reserved.</div>
          </li>
        </ul>
      </div>
    </transition>
   <img id='left_btn' @click='enter' src='../assets/images/left_btn.png'>
  </div>
</template>

<script>
export default {
  name: 'left',
  data () {
    return {
      fade: false,
      linklist: [
        {content: '▶ Home', link: '/'},
        {content: '▶ Profile', link: '/mypage'},
        {content: '▶ Boards', link: '/'},
        {content: '▶ Teams', link: '/'},
        {content: '▶ Calendar', link: '/'},
        {content: '▶ Settings', link: '/'}
      ]
    }
  },
  methods: {
    enter: function () {
      this.fade = !this.fade
    },
    resize: function () {
      $(window).resize(function () {
        var height = (window.innerHeight / 2) + 'px'
        // var height = window.innerHeight
        // var height = window.outerHeight
        $('#left_btn').css({'top': height})
      })
    }
  },
  created () {
    this.resize()
  }
}
</script>

<style>
  a{text-decoration:none; color:white}
  a:hover{color:rgba(0,0,0, 0.4);}
  .left{
    /* position:relative; */
    position:fixed;
    top:42px;
    left:0px;
    width:300px;
    height:100%;
    /* background:rgba(50,90,140, 0.6); */
    background:rgba(0, 0, 0, 0.8);
    padding:40px 0;
    float:left
  }
  .toggle-enter-active, .toggle-leave-active{
    transition: all 1s
  }
  .toggle-enter , .toggle-leave-to{
    left:-300px;
    width:0px;
  }
  .toggle-enter-to , .toggle-leave {
    left:0px;
    width:300px;
  }
  .left ul { padding: 0 20px; position:fixed;}
  .left ul li { list-style-type : none; font-size:25px;  height:65px;}
  /* .left ul li#lists { list-style-image: url("../assets/images/glass.png"); font-size:25px;  height:75px;} */
  .left ul li#lists:before { font-size:25px; height:75px; padding: 0px 10px;}  /* content: "〉"; content: ">";*/
  .left ul li#lists { font-size:25px; height:60px; padding: 0px 10px;}
  .left ul li#logo { font-family: 'Passion One', cursive; font-size:50px; height:140px; padding: 5 30px;}
  .left ul li#logo div {line-height: 0.8}
  .left ul li#copyright {font-size:14px; color:rgba(255,255,255,0.7); margin-top:80px; }
  #left_btn { height: 16px;
  width: 16px; position:fixed; top:12px; left:12px; cursor:pointer}
</style>
