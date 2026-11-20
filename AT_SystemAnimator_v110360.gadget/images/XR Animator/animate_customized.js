// user defined

MMD_SA_options.OSC = {
  VMC: {
    send: { port:39539, host:'localhost' }
  }
};

// XRA-lite: hand contact correction (must load before the pose worker is created)
// body motion first: hands are placed relative to the moved torso
document.write('<script src="js/xra_body_motion.js"></scr'+'ipt>');
document.write('<script src="js/xra_hand_contact.js"></scr'+'ipt>');
