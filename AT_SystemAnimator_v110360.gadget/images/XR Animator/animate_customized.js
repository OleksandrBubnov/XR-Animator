// user defined

MMD_SA_options.OSC = {
  VMC: {
    send: { port:39539, host:'localhost' }
  }
};

// XRA-lite: hand contact correction (must load before the pose worker is created)
document.write('<script src="js/xra_hand_contact.js"></scr'+'ipt>');
