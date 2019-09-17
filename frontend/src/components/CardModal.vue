<template>
  <transition name="card-modal">
    <div class="modal-mask">
      <div class="modal-wrapper">
        <div class="modal-container">

          <div class="modal-header">
            <slot name="header">default header</slot>
          </div>

          <div class="modal-body">
            <div class="modal-body-left">
              <div class="modal-body-description">
                <slot name="description">default description</slot>
              </div>
              <div class="modal-body-activity">
                <slot name="activity">default activity</slot>
              </div>
            </div>
            <div class="modal-body-right">
              <div class="modal-body-menu">
                <slot name="menu">default menu</slot>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <slot name="footer">
              default footer
              <button class="modal-default-button" @click="$emit('close')">
                OK
              </button>
            </slot>
          </div>

          <div class="clear">
          </div>

        </div>
      </div>
    </div>
  </transition>
</template>

<script>
export default {
}
</script>

<style>
.modal-mask {
  position: fixed;
  z-index: 9998;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, .5);
  display: table;
  transition: opacity .3s ease;
}
.modal-wrapper {
  display: table-cell;
  vertical-align: middle;
}
.modal-container {
  width: 500px;
  margin: 0px auto;
  padding: 20px 30px;
  background-color: #fff;
  border-radius: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, .33);
  transition: all .3s ease;
  font-family: Helvetica, Arial, sans-serif;
}
.modal-header h3 {
  margin-top: 0;
  color: #42b983;
}
.modal-body-left {
  float: left;
  width: 70%;
}
.modal-body-right {
  float: right;
  width: 30%;
}
.modal-footer {
  margin: 20px 0;
}
.modal-default-button {
  float: right;
  text-decoration: none;
  color: #999;
}
/* make float block as visible */
.clear {
  clear: both;
}
/*
 * The following styles are auto-applied to elements with
 * transition="modal" when their visibility is toggled
 * by Vue.js.
 *
 * You can easily play with the modal transition by editing
 * these styles.
 */
.modal-enter {
  opacity: 0;
}
.modal-leave-active {
  opacity: 0;
}
.modal-enter .modal-container,
.modal-leave-active .modal-container {
  -webkit-transform: scale(1.1);
  transform: scale(1.1);
}
</style>
